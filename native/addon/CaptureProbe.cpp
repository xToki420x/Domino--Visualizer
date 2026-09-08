#include "CaptureProbe.h"

#include <mfapi.h>
#include <mferror.h>
#include <mfidl.h>
#include <mfreadwrite.h>
#include <mfvirtualcamera.h>
#include <ks.h>
#include <ksproxy.h>
#include <mfcaptureengine.h>
#include <dshow.h>
#include <wrl/client.h>

#include <cstdio>
#include <thread>

namespace domino {

using Microsoft::WRL::ComPtr;

namespace {

/**
 * Progress reporting for the probe, on stderr when DOMINO_VCAM_VERBOSE is set.
 *
 * Opening a camera is a chain of calls into another process, any of which can
 * block indefinitely; knowing which one stopped is the difference between a
 * diagnosis and a guess.
 */
void Step(const char* what) {
  static const bool verbose = getenv("DOMINO_VCAM_VERBOSE") != nullptr;
  if (!verbose) return;
  fprintf(stderr, "[vcam] %s\n", what);
  fflush(stderr);
}

/**
 * Run `work` on a fresh thread that has joined the multithreaded apartment.
 *
 * Opening a Frame Server camera marshals calls into another process. On a
 * single-threaded apartment that needs a running message pump, and a process
 * blocking on the result simply deadlocks - which is what happened here,
 * identically for our own camera and for an unrelated vendor one, until this
 * was added. A dedicated MTA thread sidesteps the question entirely and costs
 * one thread per probe.
 */
template <typename Work>
bool RunInMta(Work work) {
  bool result = false;
  std::thread worker([&] {
    HRESULT hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    if (FAILED(hr)) return;
    result = work();
    CoUninitialize();
  });
  worker.join();
  return result;
}

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

namespace {

bool EnumerateCamerasInMta(std::vector<std::wstring>* names, std::wstring* error) {
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

}  // namespace

bool MediaFoundationAvailable() {
  // LoadLibrary rather than MFStartup: on a machine without the feature the
  // DLL is absent, and asking for it directly is both cheaper and unambiguous.
  HMODULE mfplat = LoadLibraryW(L"mfplat.dll");
  if (!mfplat) return false;
  FreeLibrary(mfplat);
  return true;
}

bool EnumerateCameras(std::vector<std::wstring>* names, std::wstring* error) {
  if (!names) return false;
  names->clear();
  return RunInMta([&] { return EnumerateCamerasInMta(names, error); });
}

namespace {

bool EnumerateDirectShowInMta(std::vector<std::wstring>* names,
                              std::wstring* error) {
  ComPtr<ICreateDevEnum> devices;
  HRESULT hr = CoCreateInstance(CLSID_SystemDeviceEnum, nullptr,
                                CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&devices));
  if (FAILED(hr)) {
    if (error) *error = L"Could not create the DirectShow device enumerator";
    return false;
  }

  ComPtr<IEnumMoniker> monikers;
  hr = devices->CreateClassEnumerator(CLSID_VideoInputDeviceCategory, &monikers,
                                      0);
  // S_FALSE means the category is empty, which is an answer rather than a
  // failure - a machine with no cameras at all is perfectly legal.
  if (hr != S_OK) return true;

  ComPtr<IMoniker> moniker;
  while (monikers->Next(1, moniker.ReleaseAndGetAddressOf(), nullptr) == S_OK) {
    ComPtr<IPropertyBag> properties;
    if (FAILED(moniker->BindToStorage(nullptr, nullptr,
                                      IID_PPV_ARGS(&properties)))) {
      continue;
    }
    VARIANT value;
    VariantInit(&value);
    if (SUCCEEDED(properties->Read(L"FriendlyName", &value, nullptr)) &&
        value.vt == VT_BSTR && value.bstrVal) {
      names->push_back(value.bstrVal);
    }
    VariantClear(&value);
  }
  return true;
}

}  // namespace

bool EnumerateDirectShowCameras(std::vector<std::wstring>* names,
                                std::wstring* error) {
  if (!names) return false;
  names->clear();
  return RunInMta([&] { return EnumerateDirectShowInMta(names, error); });
}

namespace {

/** Drive a media source with a source reader until one frame comes out. */
bool ReadFirstSample(IMFMediaSource* source, uint32_t timeoutMs,
                     CapturedFrame* out, std::wstring* error) {
  Step("creating the source reader");
  ComPtr<IMFSourceReader> reader;
  HRESULT hr = MFCreateSourceReaderFromMediaSource(source, nullptr, &reader);
  Step("source reader created");
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

namespace {

bool CaptureOneFrameInMta(const std::wstring& nameContains, uint32_t timeoutMs,
                          CapturedFrame* out, std::wstring* error) {
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

  Step("enumerating devices");
  IMFActivate** devices = nullptr;
  UINT32 count = 0;
  if (FAILED(MFEnumDeviceSources(attributes.Get(), &devices, &count))) {
    if (error) *error = L"MFEnumDeviceSources failed";
    return false;
  }
  Step("enumerated");

  ComPtr<IMFMediaSource> source;
  std::wstring chosenName;
  for (UINT32 i = 0; i < count; i++) {
    std::wstring name;
    if (!source && FriendlyName(devices[i], &name) &&
        Contains(name, nameContains)) {
      Step("activating the matching device");
      if (SUCCEEDED(devices[i]->ActivateObject(IID_PPV_ARGS(&source)))) {
        chosenName = name;
        Step("activated");
      } else {
        Step("activation failed");
      }
    }
    devices[i]->Release();
  }
  CoTaskMemFree(devices);

  if (!source) {
    if (error) *error = L"No matching camera could be opened";
    return false;
  }

  Step("reading a sample");
  const bool ok = ReadFirstSample(source.Get(), timeoutMs, out, error);
  Step(ok ? "sample read" : "sample read failed");
  if (ok) out->deviceName = chosenName;
  source->Shutdown();
  return ok;
}

}  // namespace

bool CaptureOneFrame(const std::wstring& nameContains, uint32_t timeoutMs,
                     CapturedFrame* out, std::wstring* error) {
  if (!out) return false;
  return RunInMta(
      [&] { return CaptureOneFrameInMta(nameContains, timeoutMs, out, error); });
}

namespace {

// {6F3B9C2E-1A47-4E58-9D31-7C2A5E8B4F10} - must match the DLL and the registry.
constexpr GUID kClsidDominoMediaSource = {
    0x6f3b9c2e, 0x1a47, 0x4e58, {0x9d, 0x31, 0x7c, 0x2a, 0x5e, 0x8b, 0x4f, 0x10}};

/**
 * Do by hand what COM does once it has resolved a CLSID.
 *
 * What comes back is an activate object, not the media source: that is the
 * contract for a camera CLSID, and ActivateSource below takes the second step.
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

/** Take the activate object the class factory returned and open the source. */
bool ActivateSource(IUnknown* object, IMFMediaSource** source,
                    std::wstring* error) {
  ComPtr<IMFActivate> activate;
  if (FAILED(object->QueryInterface(IID_PPV_ARGS(activate.GetAddressOf())))) {
    if (error) *error = L"The class is not an activate object";
    return false;
  }
  if (FAILED(activate->ActivateObject(IID_PPV_ARGS(source)))) {
    if (error) *error = L"ActivateObject did not produce a media source";
    return false;
  }
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
  IUnknown* probeSink = nullptr;
  if (!CreateSourceFromDll(dllPath, &module, unknown.GetAddressOf(), createHr,
                           error)) {
    return false;
  }

  // The class object itself is the activate; the source lives behind it.
  results->push_back(
      {L"IMFActivate (on the class)",
       static_cast<int32_t>(unknown->QueryInterface(
           __uuidof(IMFActivate), reinterpret_cast<void**>(&probeSink)))});
  if (probeSink) {
    probeSink->Release();
    probeSink = nullptr;
  }

  ComPtr<IMFMediaSource> source;
  if (!ActivateSource(unknown.Get(), source.GetAddressOf(), error)) {
    unknown.Reset();
    FreeLibrary(module);
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
    HRESULT probeHr = source->QueryInterface(entry.iid, &probe);
    results->push_back({entry.name, static_cast<int32_t>(probeHr)});
  }

  source->Shutdown();

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
  if (!ActivateSource(unknown.Get(), source.GetAddressOf(), error)) {
    unknown.Reset();
    FreeLibrary(module);
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
