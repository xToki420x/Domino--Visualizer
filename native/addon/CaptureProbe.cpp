#include "CaptureProbe.h"

#include <mfapi.h>
#include <mferror.h>
#include <mfidl.h>
#include <mfreadwrite.h>
#include <mfvirtualcamera.h>
#include <ks.h>
#include <ksproxy.h>
#include <mfcaptureengine.h>
#include <wrl/client.h>

namespace domino {

using Microsoft::WRL::ComPtr;

namespace {

/** RAII around MFStartup so an early return cannot leave MF initialised. */
class MFSession {
 public:
  HRESULT Start() {
    HRESULT hr = MFStartup(MF_VERSION, MFSTARTUP_NOSOCKET);
    started_ = SUCCEEDED(hr);
    return hr;
  }
  ~MFSession() {
    if (started_) MFShutdown();
  }

 private:
  bool started_ = false;
};

bool FriendlyName(IMFActivate* device, std::wstring* out) {
  WCHAR* name = nullptr;
  UINT32 length = 0;
  if (FAILED(device->GetAllocatedString(MF_DEVSOURCE_ATTRIBUTE_FRIENDLY_NAME,
                                        &name, &length))) {
    return false;
  }
  out->assign(name, length);
  CoTaskMemFree(name);
  return true;
}

HRESULT CreateVideoDeviceEnumerator(IMFAttributes** attributes) {
  HRESULT hr = MFCreateAttributes(attributes, 1);
  if (FAILED(hr)) return hr;
  return (*attributes)
      ->SetGUID(MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE,
                MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_GUID);
}

bool Contains(const std::wstring& haystack, const std::wstring& needle) {
  return needle.empty() || haystack.find(needle) != std::wstring::npos;
}

}  // namespace

bool EnumerateCameras(std::vector<std::wstring>* names, std::wstring* error) {
  if (!names) return false;
  names->clear();

  MFSession session;
  if (FAILED(session.Start())) {
    if (error) *error = L"MFStartup failed";
    return false;
  }

  ComPtr<IMFAttributes> attributes;
  if (FAILED(CreateVideoDeviceEnumerator(&attributes))) {
    if (error) *error = L"Could not build the device enumerator";
    return false;
  }

  IMFActivate** devices = nullptr;
  UINT32 count = 0;
  HRESULT hr = MFEnumDeviceSources(attributes.Get(), &devices, &count);
  if (FAILED(hr)) {
    if (error) *error = L"MFEnumDeviceSources failed";
    return false;
  }

  for (UINT32 i = 0; i < count; i++) {
    std::wstring name;
    if (FriendlyName(devices[i], &name)) names->push_back(name);
    devices[i]->Release();
  }
  CoTaskMemFree(devices);
  return true;
}

namespace {

/** Drive a media source with a source reader until one frame comes out. */
bool ReadFirstSample(IMFMediaSource* source, uint32_t timeoutMs,
                     CapturedFrame* out, std::wstring* error) {
  ComPtr<IMFSourceReader> reader;
  HRESULT hr = MFCreateSourceReaderFromMediaSource(source, nullptr, &reader);
  if (FAILED(hr)) {
    if (error) *error = L"Could not create a source reader for the camera";
    return false;
  }

  reader->SetStreamSelection(MF_SOURCE_READER_ALL_STREAMS, FALSE);
  reader->SetStreamSelection(MF_SOURCE_READER_FIRST_VIDEO_STREAM, TRUE);

  /*
   * Read until a sample arrives or the deadline passes. A live source legally
   * returns S_OK with a null sample when it has nothing yet, so an empty read
   * is not an error - only running out of time is.
   */
  const ULONGLONG deadline = GetTickCount64() + timeoutMs;
  ComPtr<IMFSample> sample;
  while (GetTickCount64() < deadline) {
    DWORD streamFlags = 0;
    LONGLONG timestamp = 0;
    ComPtr<IMFSample> candidate;
    hr = reader->ReadSample(MF_SOURCE_READER_FIRST_VIDEO_STREAM, 0, nullptr,
                            &streamFlags, &timestamp, &candidate);
    if (FAILED(hr)) {
      if (error) *error = L"ReadSample failed";
      return false;
    }
    if (streamFlags & MF_SOURCE_READERF_ENDOFSTREAM) break;
    if (candidate) {
      sample = candidate;
      break;
    }
  }

  if (!sample) {
    if (error) *error = L"The camera opened but produced no frame in time";
    return false;
  }

  // Ask what was actually negotiated rather than assuming our own numbers -
  // the point of the probe is to observe what a consumer really receives.
  ComPtr<IMFMediaType> type;
  UINT32 width = 0, height = 0;
  if (SUCCEEDED(reader->GetCurrentMediaType(MF_SOURCE_READER_FIRST_VIDEO_STREAM,
                                            &type))) {
    MFGetAttributeSize(type.Get(), MF_MT_FRAME_SIZE, &width, &height);
  }

  ComPtr<IMFMediaBuffer> buffer;
  if (FAILED(sample->ConvertToContiguousBuffer(&buffer))) {
    if (error) *error = L"Could not flatten the captured sample";
    return false;
  }

  BYTE* bytes = nullptr;
  DWORD maxLength = 0, currentLength = 0;
  if (FAILED(buffer->Lock(&bytes, &maxLength, &currentLength))) {
    if (error) *error = L"Could not lock the captured buffer";
    return false;
  }

  out->width = width;
  out->height = height;
  out->data.assign(bytes, bytes + currentLength);
  buffer->Unlock();
  return true;
}

}  // namespace

bool CaptureOneFrame(const std::wstring& nameContains, uint32_t timeoutMs,
                     CapturedFrame* out, std::wstring* error) {
  if (!out) return false;

  MFSession session;
  if (FAILED(session.Start())) {
    if (error) *error = L"MFStartup failed";
    return false;
  }

  ComPtr<IMFAttributes> attributes;
  if (FAILED(CreateVideoDeviceEnumerator(&attributes))) {
    if (error) *error = L"Could not build the device enumerator";
    return false;
  }

  IMFActivate** devices = nullptr;
  UINT32 count = 0;
  if (FAILED(MFEnumDeviceSources(attributes.Get(), &devices, &count))) {
    if (error) *error = L"MFEnumDeviceSources failed";
    return false;
  }

  ComPtr<IMFMediaSource> source;
  std::wstring chosenName;
  for (UINT32 i = 0; i < count; i++) {
    std::wstring name;
    if (!source && FriendlyName(devices[i], &name) &&
        Contains(name, nameContains)) {
      if (SUCCEEDED(devices[i]->ActivateObject(IID_PPV_ARGS(&source)))) {
        chosenName = name;
      }
    }
    devices[i]->Release();
  }
  CoTaskMemFree(devices);

  if (!source) {
    if (error) *error = L"No matching camera could be opened";
    return false;
  }

  const bool ok = ReadFirstSample(source.Get(), timeoutMs, out, error);
  if (ok) out->deviceName = chosenName;
  source->Shutdown();
  return ok;
}

namespace {

// {6F3B9C2E-1A47-4E58-9D31-7C2A5E8B4F10} - must match the DLL and the registry.
constexpr GUID kClsidDominoMediaSource = {
    0x6f3b9c2e, 0x1a47, 0x4e58, {0x9d, 0x31, 0x7c, 0x2a, 0x5e, 0x8b, 0x4f, 0x10}};

/**
 * Do by hand what COM does once it has resolved a CLSID.
 *
 * On success the caller owns both the object and a reference on the module,
 * and must release the object before calling FreeLibrary - unloading a DLL
 * that still has live objects in it is a crash waiting to happen.
 */
bool CreateSourceFromDll(const std::wstring& dllPath, HMODULE* moduleOut,
                         IUnknown** objectOut, int32_t* createHr,
                         std::wstring* error) {
  *moduleOut = nullptr;
  *objectOut = nullptr;

  HMODULE module = LoadLibraryW(dllPath.c_str());
  if (!module) {
    if (error) *error = L"The media source DLL could not be loaded";
    return false;
  }

  using GetClassObjectFn = HRESULT(STDAPICALLTYPE*)(REFCLSID, REFIID, void**);
  auto getClassObject = reinterpret_cast<GetClassObjectFn>(
      GetProcAddress(module, "DllGetClassObject"));
  if (!getClassObject) {
    FreeLibrary(module);
    if (error) *error = L"The DLL does not export DllGetClassObject";
    return false;
  }

  ComPtr<IClassFactory> factory;
  HRESULT hr = getClassObject(kClsidDominoMediaSource,
                              IID_PPV_ARGS(factory.GetAddressOf()));
  if (FAILED(hr)) {
    FreeLibrary(module);
    if (createHr) *createHr = static_cast<int32_t>(hr);
    if (error) *error = L"The DLL would not hand over a class factory";
    return false;
  }

  hr = factory->CreateInstance(nullptr, IID_PPV_ARGS(objectOut));
  if (createHr) *createHr = static_cast<int32_t>(hr);
  if (FAILED(hr)) {
    FreeLibrary(module);
    if (error) *error = L"The class factory would not create a media source";
    return false;
  }

  *moduleOut = module;
  return true;
}

}  // namespace

bool ProbeSourceClass(const std::wstring& dllPath,
                      std::vector<InterfaceProbe>* results, int32_t* createHr,
                      std::wstring* error) {
  if (!results) return false;
  results->clear();

  MFSession session;
  if (FAILED(session.Start())) {
    if (error) *error = L"MFStartup failed";
    return false;
  }

  HMODULE module = nullptr;
  ComPtr<IUnknown> unknown;
  if (!CreateSourceFromDll(dllPath, &module, unknown.GetAddressOf(), createHr,
                           error)) {
    return false;
  }

  struct Entry {
    const wchar_t* name;
    IID iid;
  };
  const Entry entries[] = {
      {L"IMFMediaSource", __uuidof(IMFMediaSource)},
      {L"IMFMediaSourceEx", __uuidof(IMFMediaSourceEx)},
      {L"IMFMediaEventGenerator", __uuidof(IMFMediaEventGenerator)},
      {L"IMFGetService", __uuidof(IMFGetService)},
      {L"IKsControl", __uuidof(IKsControl)},
      {L"IMFSampleAllocatorControl", __uuidof(IMFSampleAllocatorControl)},
      {L"IMFAttributes", __uuidof(IMFAttributes)},
      {L"IMFActivate", __uuidof(IMFActivate)},
      {L"IMFRealTimeClientEx", __uuidof(IMFRealTimeClientEx)},
  };

  for (const Entry& entry : entries) {
    ComPtr<IUnknown> probe;
    HRESULT probeHr = unknown->QueryInterface(entry.iid, &probe);
    results->push_back({entry.name, static_cast<int32_t>(probeHr)});
  }

  ComPtr<IMFMediaSource> source;
  if (SUCCEEDED(unknown.As(&source))) source->Shutdown();

  // Release everything before unloading, or the DLL is freed out from under
  // objects that still exist.
  unknown.Reset();
  source.Reset();
  FreeLibrary(module);
  return true;
}

bool CaptureFromDll(const std::wstring& dllPath, uint32_t timeoutMs,
                    CapturedFrame* out, std::wstring* error) {
  if (!out) return false;

  MFSession session;
  if (FAILED(session.Start())) {
    if (error) *error = L"MFStartup failed";
    return false;
  }

  HMODULE module = nullptr;
  ComPtr<IUnknown> unknown;
  int32_t createHr = 0;
  if (!CreateSourceFromDll(dllPath, &module, unknown.GetAddressOf(), &createHr,
                           error)) {
    return false;
  }

  ComPtr<IMFMediaSource> source;
  if (FAILED(unknown.As(&source))) {
    unknown.Reset();
    FreeLibrary(module);
    if (error) *error = L"The object is not a media source";
    return false;
  }

  const bool ok = ReadFirstSample(source.Get(), timeoutMs, out, error);
  if (ok) out->deviceName = L"Domino (direct)";

  source->Shutdown();
  source.Reset();
  unknown.Reset();
  FreeLibrary(module);
  return ok;
}

}  // namespace domino
