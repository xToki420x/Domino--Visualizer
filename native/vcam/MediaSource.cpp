#include "MediaSource.h"

#include "FrameReader.h"
#include "MediaStream.h"
#include "Trace.h"

namespace domino {

namespace {

// Used only when the visualiser is not running at the moment the camera is
// opened. A consumer that opens the camera first and starts Domino second
// still gets a working stream, just at this default size.
constexpr uint32_t kFallbackWidth = 1280;
constexpr uint32_t kFallbackHeight = 720;
constexpr uint32_t kFallbackFpsNum = 30;
constexpr uint32_t kFallbackFpsDen = 1;

}  // namespace

HRESULT MediaSource::Create(REFIID riid, void** ppv) {
  if (!ppv) return E_POINTER;
  *ppv = nullptr;

  MediaSource* source = new (std::nothrow) MediaSource();
  if (!source) return E_OUTOFMEMORY;

  HRESULT hr = source->Initialize();
  if (SUCCEEDED(hr)) hr = source->QueryInterface(riid, ppv);
  source->Release();
  return hr;
}

MediaSource::~MediaSource() {
  if (stream_) stream_->Release();
  if (descriptor_) descriptor_->Release();
  if (attributes_) attributes_->Release();
  if (eventQueue_) eventQueue_->Release();
  ModuleRelease();
}

HRESULT MediaSource::Initialize() {
  ModuleAddRef();

  /*
   * No MFStartup here, and above all no MFShutdown.
   *
   * This object lives inside a host we do not own - the Windows Frame Server,
   * or a capture application. That host started Media Foundation before it
   * ever reached us, and shutting it down when our last source is released
   * would tear the platform out from under everything else the host is doing.
   * A hosted media source uses the platform; it does not manage its lifetime.
   */

  /*
   * Take the frame geometry from the live channel rather than hard-coding it.
   * Domino opens the channel before it publishes the camera, so by the time
   * anything can instantiate this class the real size is already on record,
   * and the media type we advertise matches the frames that will arrive.
   */
  uint32_t width = kFallbackWidth;
  uint32_t height = kFallbackHeight;
  uint32_t fpsNum = kFallbackFpsNum;
  uint32_t fpsDen = kFallbackFpsDen;
  {
    FrameReader probe;
    if (probe.Open()) {
      const uint32_t w = probe.Width();
      const uint32_t h = probe.Height();
      if (w >= 2 && h >= 2 && w <= kMaxWidth && h <= kMaxHeight &&
          (w % 2) == 0 && (h % 2) == 0) {
        width = w;
        height = h;
      }
      if (probe.FrameRateNum() > 0 && probe.FrameRateDen() > 0) {
        fpsNum = probe.FrameRateNum();
        fpsDen = probe.FrameRateDen();
      }
    }
  }

  HRESULT hr = MFCreateEventQueue(&eventQueue_);
  if (FAILED(hr)) return hr;

  hr = MFCreateAttributes(&attributes_, 1);
  if (FAILED(hr)) return hr;
  attributes_->SetUINT32(MF_DEVICESTREAM_ATTRIBUTE_FRAMESOURCE_TYPES,
                         MFFrameSourceTypes_Color);

  hr = MediaStream::Create(this, width, height, fpsNum, fpsDen, &stream_);
  if (FAILED(hr)) return hr;

  IMFStreamDescriptor* descriptors[] = {stream_->Descriptor()};
  hr = MFCreatePresentationDescriptor(1, descriptors, &descriptor_);
  if (FAILED(hr)) return hr;

  // The only stream, and it is always on: a camera with its single stream
  // deselected would be published and then produce nothing.
  hr = descriptor_->SelectStream(0);
  Trace("MediaSource::Initialize %ux%u -> 0x%08lX", width, height, hr);
  return hr;
}

// --- IUnknown ---------------------------------------------------------------

IFACEMETHODIMP MediaSource::QueryInterface(REFIID riid, void** ppv) {
  if (!ppv) return E_POINTER;

  if (riid == __uuidof(IUnknown) || riid == __uuidof(IMFMediaEventGenerator) ||
      riid == __uuidof(IMFMediaSource) || riid == __uuidof(IMFMediaSourceEx)) {
    *ppv = static_cast<IMFMediaSourceEx*>(this);
  } else if (riid == __uuidof(IMFGetService)) {
    *ppv = static_cast<IMFGetService*>(this);
  } else if (riid == __uuidof(IKsControl)) {
    *ppv = static_cast<IKsControl*>(this);
  } else if (riid == __uuidof(IMFSampleAllocatorControl)) {
    *ppv = static_cast<IMFSampleAllocatorControl*>(this);
  } else {
    *ppv = nullptr;
    // The interface Windows wanted and did not get is exactly the thing an
    // E_NOINTERFACE from the Frame Server refuses to tell us.
    Trace("QueryInterface REFUSED {%08lX-%04X-%04X-%02X%02X%02X%02X%02X%02X%02X%02X}",
          riid.Data1, riid.Data2, riid.Data3, riid.Data4[0], riid.Data4[1],
          riid.Data4[2], riid.Data4[3], riid.Data4[4], riid.Data4[5],
          riid.Data4[6], riid.Data4[7]);
    return E_NOINTERFACE;
  }
  AddRef();
  return S_OK;
}

IFACEMETHODIMP_(ULONG) MediaSource::AddRef() {
  return InterlockedIncrement(&refCount_);
}

IFACEMETHODIMP_(ULONG) MediaSource::Release() {
  ULONG count = InterlockedDecrement(&refCount_);
  if (count == 0) delete this;
  return count;
}

// --- IMFMediaEventGenerator -------------------------------------------------

IFACEMETHODIMP MediaSource::BeginGetEvent(IMFAsyncCallback* callback,
                                          IUnknown* state) {
  Guard guard(lock_);
  HRESULT hr = CheckShutdown();
  if (FAILED(hr)) return hr;
  return eventQueue_->BeginGetEvent(callback, state);
}

IFACEMETHODIMP MediaSource::EndGetEvent(IMFAsyncResult* result,
                                        IMFMediaEvent** event) {
  Guard guard(lock_);
  HRESULT hr = CheckShutdown();
  if (FAILED(hr)) return hr;
  return eventQueue_->EndGetEvent(result, event);
}

IFACEMETHODIMP MediaSource::GetEvent(DWORD flags, IMFMediaEvent** event) {
  IMFMediaEventQueue* queue = nullptr;
  {
    Guard guard(lock_);
    HRESULT hr = CheckShutdown();
    if (FAILED(hr)) return hr;
    queue = eventQueue_;
    queue->AddRef();
  }
  // Blocking call, so the lock is released first - see the matching comment in
  // MediaStream::GetEvent.
  HRESULT hr = queue->GetEvent(flags, event);
  queue->Release();
  return hr;
}

IFACEMETHODIMP MediaSource::QueueEvent(MediaEventType type, REFGUID extendedType,
                                       HRESULT status, const PROPVARIANT* value) {
  Guard guard(lock_);
  HRESULT hr = CheckShutdown();
  if (FAILED(hr)) return hr;
  return eventQueue_->QueueEventParamVar(type, extendedType, status, value);
}

// --- IMFMediaSource ---------------------------------------------------------

IFACEMETHODIMP MediaSource::CreatePresentationDescriptor(
    IMFPresentationDescriptor** pd) {
  if (!pd) return E_POINTER;
  Guard guard(lock_);
  HRESULT hr = CheckShutdown();
  if (FAILED(hr)) return hr;
  // A clone, so a caller selecting or deselecting streams cannot reach into
  // the descriptor this source is still using.
  return descriptor_->Clone(pd);
}

IFACEMETHODIMP MediaSource::GetCharacteristics(DWORD* characteristics) {
  if (!characteristics) return E_POINTER;
  Guard guard(lock_);
  HRESULT hr = CheckShutdown();
  if (FAILED(hr)) return hr;
  // Live and unseekable: there is no buffered history to scrub through, and
  // claiming otherwise would invite consumers to ask for times we cannot serve.
  *characteristics = MFMEDIASOURCE_IS_LIVE;
  return S_OK;
}

IFACEMETHODIMP MediaSource::Start(IMFPresentationDescriptor* pd,
                                  const GUID* timeFormat,
                                  const PROPVARIANT* startPosition) {
  if (!pd) return E_INVALIDARG;
  // Only the default (100ns) time format is meaningful for a live source.
  if (timeFormat && *timeFormat != GUID_NULL) {
    return MF_E_UNSUPPORTED_TIME_FORMAT;
  }

  MediaStream* stream = nullptr;
  {
    Guard guard(lock_);
    HRESULT hr = CheckShutdown();
    if (FAILED(hr)) return hr;

    BOOL selected = FALSE;
    IMFStreamDescriptor* sd = nullptr;
    hr = pd->GetStreamDescriptorByIndex(0, &selected, &sd);
    if (FAILED(hr)) return hr;
    if (sd) sd->Release();
    if (!selected) return MF_E_INVALIDREQUEST;

    PROPVARIANT var;
    PropVariantInit(&var);
    var.vt = VT_UNKNOWN;
    var.punkVal = static_cast<IMFMediaStream2*>(stream_);

    /*
     * MENewStream announces a stream object the consumer has not seen before;
     * MEUpdatedStream says "same object, started again". Sending MENewStream
     * twice for one stream makes consumers believe the camera grew a second
     * stream, so the distinction matters after a stop/start cycle.
     */
    hr = eventQueue_->QueueEventParamVar(
        streamAnnounced_ ? MEUpdatedStream : MENewStream, GUID_NULL, S_OK, &var);
    PropVariantClear(&var);
    if (FAILED(hr)) return hr;
    streamAnnounced_ = true;

    stream = stream_;
    stream->AddRef();
  }

  // Outside the lock: the stream queues its own started event, and its lock is
  // ordered below this one.
  Trace("MediaSource::Start");
  HRESULT hr = stream->Start();
  stream->Release();
  if (FAILED(hr)) return hr;

  PROPVARIANT started;
  PropVariantInit(&started);
  if (startPosition && startPosition->vt == VT_I8) {
    started.vt = VT_I8;
    started.hVal.QuadPart = startPosition->hVal.QuadPart;
  } else {
    started.vt = VT_EMPTY;
  }
  hr = QueueEvent(MESourceStarted, GUID_NULL, S_OK, &started);
  PropVariantClear(&started);
  return hr;
}

IFACEMETHODIMP MediaSource::Stop() {
  MediaStream* stream = nullptr;
  {
    Guard guard(lock_);
    HRESULT hr = CheckShutdown();
    if (FAILED(hr)) return hr;
    stream = stream_;
    stream->AddRef();
  }

  stream->Stop();
  stream->Release();
  return QueueEvent(MESourceStopped, GUID_NULL, S_OK, nullptr);
}

IFACEMETHODIMP MediaSource::Pause() {
  // A live source has nothing to hold: there is no buffer to freeze and no way
  // to resume from where it left off. Consumers treat this as "stop instead".
  Guard guard(lock_);
  HRESULT hr = CheckShutdown();
  if (FAILED(hr)) return hr;
  return MF_E_INVALID_STATE_TRANSITION;
}

IFACEMETHODIMP MediaSource::Shutdown() {
  Guard guard(lock_);
  if (shutdown_) return MF_E_SHUTDOWN;
  shutdown_ = true;

  if (stream_) stream_->Shutdown();
  if (eventQueue_) eventQueue_->Shutdown();
  return S_OK;
}

// --- IMFMediaSourceEx -------------------------------------------------------

IFACEMETHODIMP MediaSource::GetSourceAttributes(IMFAttributes** attributes) {
  if (!attributes) return E_POINTER;
  Guard guard(lock_);
  HRESULT hr = CheckShutdown();
  if (FAILED(hr)) return hr;
  *attributes = attributes_;
  attributes_->AddRef();
  return S_OK;
}

IFACEMETHODIMP MediaSource::GetStreamAttributes(DWORD streamId,
                                                IMFAttributes** attributes) {
  if (!attributes) return E_POINTER;
  Guard guard(lock_);
  HRESULT hr = CheckShutdown();
  if (FAILED(hr)) return hr;
  if (streamId != 0) return MF_E_INVALIDSTREAMNUMBER;
  return stream_->GetAttributes(attributes);
}

IFACEMETHODIMP MediaSource::SetD3DManager(IUnknown* manager) {
  /*
   * Accepted, and then ignored.
   *
   * We have no use for a D3D device - frames arrive as system memory from
   * another process - but refusing this contradicts telling the host we will
   * take its allocator, and the negotiation stalls there. Whatever buffers the
   * allocator hands back, D3D-backed or not, are filled through IMF2DBuffer2,
   * which maps either kind.
   */
  Trace("SetD3DManager(%p)", manager);
  return S_OK;
}

// --- IMFGetService ----------------------------------------------------------

IFACEMETHODIMP MediaSource::GetService(REFGUID /*service*/, REFIID /*riid*/,
                                       LPVOID* ppv) {
  if (ppv) *ppv = nullptr;
  return MF_E_UNSUPPORTED_SERVICE;
}

// --- IMFSampleAllocatorControl ----------------------------------------------
//
// The Frame Server asks every software camera source how its samples are
// allocated before it will start the camera, then hands one over. Taking it is
// what makes frames reach other processes: buffers we allocate ourselves live
// in this process only, and are dropped on the way out.

IFACEMETHODIMP MediaSource::SetDefaultAllocator(DWORD outputStreamId,
                                                IUnknown* allocator) {
  Guard guard(lock_);
  HRESULT hr = CheckShutdown();
  if (FAILED(hr)) return hr;
  if (outputStreamId != 0) return MF_E_INVALIDSTREAMNUMBER;

  MediaStream* stream = stream_;
  stream->AddRef();
  guard.Release();

  // The stream lock is taken inside SetAllocator, so the source lock is
  // dropped first: holding both is the one place these two locks could be
  // acquired in opposite orders on different threads.
  Trace("SetDefaultAllocator");
  HRESULT result = stream->SetAllocator(allocator);
  stream->Release();
  return result;
}

IFACEMETHODIMP MediaSource::GetAllocatorUsage(DWORD outputStreamId,
                                              DWORD* inputStreamId,
                                              MFSampleAllocatorUsage* usage) {
  if (!inputStreamId || !usage) return E_POINTER;
  Guard guard(lock_);
  HRESULT hr = CheckShutdown();
  if (FAILED(hr)) return hr;
  if (outputStreamId != 0) return MF_E_INVALIDSTREAMNUMBER;

  *inputStreamId = 0;
  // We take the host allocator when it offers one. Claiming a custom allocator
  // instead tells the Frame Server our buffers are ours to manage, and it then
  // has nothing it can share with the application that opened the camera.
  *usage = MFSampleAllocatorUsage_UsesProvidedAllocator;
  Trace("GetAllocatorUsage -> UsesProvidedAllocator");
  return S_OK;
}

// --- IKsControl -------------------------------------------------------------
//
// Present because the Frame Server probes camera controls (exposure, white
// balance, and so on) through it. A software source has none of those, and
// ERROR_SET_NOT_FOUND is how a KS driver says "I do not implement that
// property set" - which callers handle, unlike an unexpected failure.

IFACEMETHODIMP MediaSource::KsProperty(PKSPROPERTY /*property*/,
                                       ULONG /*propertyLength*/, void* /*data*/,
                                       ULONG /*dataLength*/,
                                       ULONG* bytesReturned) {
  if (bytesReturned) *bytesReturned = 0;
  return HRESULT_FROM_WIN32(ERROR_SET_NOT_FOUND);
}

IFACEMETHODIMP MediaSource::KsMethod(PKSMETHOD /*method*/, ULONG /*methodLength*/,
                                     void* /*data*/, ULONG /*dataLength*/,
                                     ULONG* bytesReturned) {
  if (bytesReturned) *bytesReturned = 0;
  return HRESULT_FROM_WIN32(ERROR_SET_NOT_FOUND);
}

IFACEMETHODIMP MediaSource::KsEvent(PKSEVENT /*event*/, ULONG /*eventLength*/,
                                    void* /*data*/, ULONG /*dataLength*/,
                                    ULONG* bytesReturned) {
  if (bytesReturned) *bytesReturned = 0;
  return HRESULT_FROM_WIN32(ERROR_SET_NOT_FOUND);
}

}  // namespace domino
