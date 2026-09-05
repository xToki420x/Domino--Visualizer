#include "MediaStream.h"

#include "MediaSource.h"

namespace domino {

namespace {

// Limited-range BT.601 black: luma sits at 16, chroma at neutral 128. The
// media type declares MFNominalRange_16_235 and the converter in Domino
// matches it, so a dropped or missing frame reads as clean black rather than
// washed grey.
constexpr BYTE kBlackLuma = 16;
constexpr BYTE kNeutralChroma = 128;

}  // namespace

HRESULT MediaStream::Create(MediaSource* parent, uint32_t width, uint32_t height,
                            uint32_t fpsNum, uint32_t fpsDen, MediaStream** out) {
  if (!out) return E_POINTER;
  *out = nullptr;

  MediaStream* stream = new (std::nothrow) MediaStream();
  if (!stream) return E_OUTOFMEMORY;

  HRESULT hr = stream->Initialize(parent, width, height, fpsNum, fpsDen);
  if (FAILED(hr)) {
    stream->Release();
    return hr;
  }
  *out = stream;
  return S_OK;
}

MediaStream::~MediaStream() {
  if (eventQueue_) eventQueue_->Release();
  if (descriptor_) descriptor_->Release();
  if (mediaType_) mediaType_->Release();
  delete[] scratch_;
}

HRESULT MediaStream::Initialize(MediaSource* parent, uint32_t width,
                                uint32_t height, uint32_t fpsNum,
                                uint32_t fpsDen) {
  parent_ = parent;
  width_ = width;
  height_ = height;
  frameBytes_ = width * height * 3 / 2;
  frameDuration100ns_ =
      static_cast<LONGLONG>(10000000ULL * fpsDen / (fpsNum ? fpsNum : 30));

  scratch_ = new (std::nothrow) BYTE[frameBytes_];
  if (!scratch_) return E_OUTOFMEMORY;

  HRESULT hr = MFCreateEventQueue(&eventQueue_);
  if (FAILED(hr)) return hr;

  hr = MFCreateMediaType(&mediaType_);
  if (FAILED(hr)) return hr;

  mediaType_->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Video);
  mediaType_->SetGUID(MF_MT_SUBTYPE, MFVideoFormat_NV12);
  mediaType_->SetUINT32(MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive);
  mediaType_->SetUINT32(MF_MT_ALL_SAMPLES_INDEPENDENT, TRUE);
  mediaType_->SetUINT32(MF_MT_FIXED_SIZE_SAMPLES, TRUE);
  mediaType_->SetUINT32(MF_MT_SAMPLE_SIZE, frameBytes_);
  mediaType_->SetUINT32(MF_MT_DEFAULT_STRIDE, static_cast<UINT32>(width));
  mediaType_->SetUINT32(MF_MT_VIDEO_NOMINAL_RANGE, MFNominalRange_16_235);
  MFSetAttributeSize(mediaType_, MF_MT_FRAME_SIZE, width, height);
  MFSetAttributeRatio(mediaType_, MF_MT_FRAME_RATE, fpsNum, fpsDen);
  MFSetAttributeRatio(mediaType_, MF_MT_PIXEL_ASPECT_RATIO, 1, 1);

  // A single media type, whose size is whatever Domino declared when it opened
  // the channel. Offering more resolutions would mean scaling frames we did
  // not render, and a camera that quietly resamples is worse than one that
  // reports exactly what it produces.
  IMFMediaType* types[] = {mediaType_};
  hr = MFCreateStreamDescriptor(0, 1, types, &descriptor_);
  if (FAILED(hr)) return hr;

  IMFMediaTypeHandler* handler = nullptr;
  hr = descriptor_->GetMediaTypeHandler(&handler);
  if (FAILED(hr)) return hr;
  hr = handler->SetCurrentMediaType(mediaType_);
  handler->Release();
  if (FAILED(hr)) return hr;

  /*
   * The Frame Server reads these off the stream descriptor to decide what kind
   * of stream this is. Without the category it is not treated as a capture
   * pin, and without FRAMESERVER_SHARED only one client at a time could open
   * the camera - which would mean Zoom locking out everything else.
   */
  descriptor_->SetUINT32(MF_DEVICESTREAM_STREAM_ID, 0);
  descriptor_->SetGUID(MF_DEVICESTREAM_STREAM_CATEGORY, PINNAME_VIDEO_CAPTURE);
  descriptor_->SetUINT32(MF_DEVICESTREAM_FRAMESERVER_SHARED, 1);
  descriptor_->SetUINT32(MF_DEVICESTREAM_ATTRIBUTE_FRAMESOURCE_TYPES,
                         MFFrameSourceTypes_Color);
  return S_OK;
}

HRESULT MediaStream::GetAttributes(IMFAttributes** attributes) {
  if (!attributes) return E_POINTER;
  if (!descriptor_) return MF_E_SHUTDOWN;
  return descriptor_->QueryInterface(IID_PPV_ARGS(attributes));
}

// --- IUnknown ---------------------------------------------------------------

IFACEMETHODIMP MediaStream::QueryInterface(REFIID riid, void** ppv) {
  if (!ppv) return E_POINTER;
  if (riid == __uuidof(IUnknown) || riid == __uuidof(IMFMediaEventGenerator) ||
      riid == __uuidof(IMFMediaStream) || riid == __uuidof(IMFMediaStream2)) {
    *ppv = static_cast<IMFMediaStream2*>(this);
    AddRef();
    return S_OK;
  }
  *ppv = nullptr;
  return E_NOINTERFACE;
}

IFACEMETHODIMP_(ULONG) MediaStream::AddRef() {
  return InterlockedIncrement(&refCount_);
}

IFACEMETHODIMP_(ULONG) MediaStream::Release() {
  ULONG count = InterlockedDecrement(&refCount_);
  if (count == 0) delete this;
  return count;
}

// --- IMFMediaEventGenerator -------------------------------------------------

IFACEMETHODIMP MediaStream::BeginGetEvent(IMFAsyncCallback* callback,
                                          IUnknown* state) {
  Guard guard(lock_);
  if (shutdown_) return MF_E_SHUTDOWN;
  return eventQueue_->BeginGetEvent(callback, state);
}

IFACEMETHODIMP MediaStream::EndGetEvent(IMFAsyncResult* result,
                                        IMFMediaEvent** event) {
  Guard guard(lock_);
  if (shutdown_) return MF_E_SHUTDOWN;
  return eventQueue_->EndGetEvent(result, event);
}

IFACEMETHODIMP MediaStream::GetEvent(DWORD flags, IMFMediaEvent** event) {
  IMFMediaEventQueue* queue = nullptr;
  {
    Guard guard(lock_);
    if (shutdown_) return MF_E_SHUTDOWN;
    queue = eventQueue_;
    queue->AddRef();
  }
  // GetEvent can block, so the lock must not be held across it: a blocked
  // caller would otherwise stall every other method on this stream.
  HRESULT hr = queue->GetEvent(flags, event);
  queue->Release();
  return hr;
}

IFACEMETHODIMP MediaStream::QueueEvent(MediaEventType type, REFGUID extendedType,
                                       HRESULT status, const PROPVARIANT* value) {
  Guard guard(lock_);
  if (shutdown_) return MF_E_SHUTDOWN;
  return eventQueue_->QueueEventParamVar(type, extendedType, status, value);
}

// --- IMFMediaStream ---------------------------------------------------------

IFACEMETHODIMP MediaStream::GetMediaSource(IMFMediaSource** source) {
  if (!source) return E_POINTER;
  Guard guard(lock_);
  if (shutdown_ || !parent_) return MF_E_SHUTDOWN;
  return parent_->QueryInterface(IID_PPV_ARGS(source));
}

IFACEMETHODIMP MediaStream::GetStreamDescriptor(IMFStreamDescriptor** out) {
  if (!out) return E_POINTER;
  Guard guard(lock_);
  if (shutdown_) return MF_E_SHUTDOWN;
  *out = descriptor_;
  descriptor_->AddRef();
  return S_OK;
}

IFACEMETHODIMP MediaStream::RequestSample(IUnknown* token) {
  {
    Guard guard(lock_);
    if (shutdown_) return MF_E_SHUTDOWN;
    if (state_ != MF_STREAM_STATE_RUNNING) return MF_E_INVALIDREQUEST;
  }

  // Deliberately outside the lock: this blocks for up to a frame interval
  // waiting on the visualiser, and holding the lock would make Stop() wait for
  // a frame that may never come.
  IMFSample* sample = nullptr;
  HRESULT hr = CreateSample(token, &sample);
  if (FAILED(hr)) return hr;

  PROPVARIANT var;
  PropVariantInit(&var);
  var.vt = VT_UNKNOWN;
  var.punkVal = sample;  // ownership moves into the PROPVARIANT

  hr = QueueEvent(MEMediaSample, GUID_NULL, S_OK, &var);
  PropVariantClear(&var);
  return hr;
}

// --- IMFMediaStream2 --------------------------------------------------------

IFACEMETHODIMP MediaStream::SetStreamState(MF_STREAM_STATE state) {
  Guard guard(lock_);
  if (shutdown_) return MF_E_SHUTDOWN;

  switch (state) {
    case MF_STREAM_STATE_PAUSED:
      // Only meaningful from running. Anything else is already effectively
      // paused, and reporting an error would fail the whole session over a
      // transition that changes nothing.
      if (state_ == MF_STREAM_STATE_RUNNING) state_ = MF_STREAM_STATE_PAUSED;
      return S_OK;
    case MF_STREAM_STATE_RUNNING:
      state_ = MF_STREAM_STATE_RUNNING;
      return S_OK;
    case MF_STREAM_STATE_STOPPED:
      state_ = MF_STREAM_STATE_STOPPED;
      return S_OK;
    default:
      return MF_E_INVALID_STATE_TRANSITION;
  }
}

IFACEMETHODIMP MediaStream::GetStreamState(MF_STREAM_STATE* state) {
  if (!state) return E_POINTER;
  Guard guard(lock_);
  if (shutdown_) return MF_E_SHUTDOWN;
  *state = state_;
  return S_OK;
}

// --- Source-driven state ----------------------------------------------------

HRESULT MediaStream::Start() {
  {
    Guard guard(lock_);
    if (shutdown_) return MF_E_SHUTDOWN;
    state_ = MF_STREAM_STATE_RUNNING;
    startTime100ns_ = MFGetSystemTime();
    lastHeartbeat_ = 0;
    scratchValid_ = false;
  }
  return QueueEvent(MEStreamStarted, GUID_NULL, S_OK, nullptr);
}

HRESULT MediaStream::Stop() {
  {
    Guard guard(lock_);
    if (shutdown_) return MF_E_SHUTDOWN;
    state_ = MF_STREAM_STATE_STOPPED;
  }
  reader_.Close();
  return QueueEvent(MEStreamStopped, GUID_NULL, S_OK, nullptr);
}

void MediaStream::Shutdown() {
  Guard guard(lock_);
  if (shutdown_) return;
  shutdown_ = true;
  state_ = MF_STREAM_STATE_STOPPED;
  if (eventQueue_) eventQueue_->Shutdown();
  reader_.Close();
  parent_ = nullptr;
}

// --- Frame production -------------------------------------------------------

void MediaStream::WaitForNextFrame() {
  const DWORD frameMs = static_cast<DWORD>(frameDuration100ns_ / 10000);

  if (!reader_.IsOpen()) {
    // Domino may not be running yet, or may have restarted. Retrying on every
    // request is cheap - OpenFileMapping on a missing name fails immediately -
    // and it means the camera recovers on its own the moment frames reappear.
    if (!reader_.Open()) {
      Sleep(frameMs);
      return;
    }
    lastHeartbeat_ = 0;
  }

  if (!reader_.ProducerAlive()) {
    reader_.Close();
    scratchValid_ = false;
    Sleep(frameMs);
    return;
  }

  if (reader_.Heartbeat() != lastHeartbeat_) return;  // one is already waiting

  /*
   * Wait rather than spin. This is what paces the stream: consumers request
   * samples as fast as we hand them back, so without a wait here a 30fps
   * visualiser would be delivered as hundreds of duplicate frames a second.
   * The generous timeout means a stalled visualiser degrades to black frames
   * at roughly the declared rate instead of hanging the consumer.
   */
  reader_.WaitForFrame(frameMs * 2 + 5);
}

HRESULT MediaStream::FillBuffer(IMFMediaBuffer* buffer) {
  IMF2DBuffer2* buffer2d = nullptr;
  HRESULT hr = buffer->QueryInterface(IID_PPV_ARGS(&buffer2d));
  if (FAILED(hr)) return hr;

  BYTE* scanline0 = nullptr;
  LONG pitch = 0;
  BYTE* start = nullptr;
  DWORD length = 0;
  hr = buffer2d->Lock2DSize(MF2DBuffer_LockFlags_Write, &scanline0, &pitch,
                            &start, &length);
  if (FAILED(hr)) {
    buffer2d->Release();
    return hr;
  }

  WaitForNextFrame();

  uint32_t frameWidth = 0;
  uint32_t frameHeight = 0;
  size_t bytes = 0;
  if (reader_.IsOpen()) {
    bytes = reader_.ReadLatest(scratch_, frameBytes_, &frameWidth, &frameHeight);
    // A frame of a different size cannot be shown under the media type already
    // negotiated, and silently stretching it would misrepresent what the
    // camera produces. Keep showing the previous frame instead.
    if (bytes > 0 && (frameWidth != width_ || frameHeight != height_)) bytes = 0;
    if (bytes > 0) {
      scratchValid_ = true;
      lastHeartbeat_ = reader_.Heartbeat();
    }
  }

  if (scratchValid_) {
    const BYTE* srcY = scratch_;
    for (uint32_t row = 0; row < height_; row++) {
      memcpy(scanline0 + static_cast<size_t>(pitch) * row,
             srcY + static_cast<size_t>(width_) * row, width_);
    }
    // NV12 in a 2D buffer keeps the interleaved chroma plane immediately after
    // `height` luma rows, at the same pitch.
    BYTE* dstUV = scanline0 + static_cast<size_t>(pitch) * height_;
    const BYTE* srcUV = scratch_ + static_cast<size_t>(width_) * height_;
    for (uint32_t row = 0; row < height_ / 2; row++) {
      memcpy(dstUV + static_cast<size_t>(pitch) * row,
             srcUV + static_cast<size_t>(width_) * row, width_);
    }
  } else {
    for (uint32_t row = 0; row < height_; row++) {
      memset(scanline0 + static_cast<size_t>(pitch) * row, kBlackLuma, width_);
    }
    BYTE* dstUV = scanline0 + static_cast<size_t>(pitch) * height_;
    for (uint32_t row = 0; row < height_ / 2; row++) {
      memset(dstUV + static_cast<size_t>(pitch) * row, kNeutralChroma, width_);
    }
  }

  buffer2d->Unlock2D();

  DWORD contiguous = 0;
  if (SUCCEEDED(buffer2d->GetContiguousLength(&contiguous))) {
    buffer->SetCurrentLength(contiguous);
  }
  buffer2d->Release();
  return S_OK;
}

HRESULT MediaStream::CreateSample(IUnknown* token, IMFSample** out) {
  *out = nullptr;

  IMFMediaBuffer* buffer = nullptr;
  HRESULT hr = MFCreate2DMediaBuffer(width_, height_, MFVideoFormat_NV12.Data1,
                                     FALSE, &buffer);
  if (FAILED(hr)) return hr;

  hr = FillBuffer(buffer);
  if (FAILED(hr)) {
    buffer->Release();
    return hr;
  }

  IMFSample* sample = nullptr;
  hr = MFCreateSample(&sample);
  if (SUCCEEDED(hr)) hr = sample->AddBuffer(buffer);
  buffer->Release();
  if (FAILED(hr)) {
    if (sample) sample->Release();
    return hr;
  }

  // Timestamps run off the system clock rather than a frame counter: this is a
  // live source, and a counter would drift against the consumer clock every
  // time we dropped or repeated a frame.
  sample->SetSampleTime(MFGetSystemTime() - startTime100ns_);
  sample->SetSampleDuration(frameDuration100ns_);
  sample->SetUINT32(MFSampleExtension_CleanPoint, TRUE);
  if (token) sample->SetUnknown(MFSampleExtension_Token, token);

  *out = sample;
  return S_OK;
}

}  // namespace domino
