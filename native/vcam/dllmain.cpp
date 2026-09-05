// COM entry points for the Domino virtual-camera media source.
//
// Windows loads this DLL inside the Frame Server process when an application
// opens the Domino camera. Nothing here runs in Domino itself, which is why it
// links against no part of the app and reaches the visualiser only through
// shared memory.

#include "Precomp.h"

#include "MediaSource.h"
#include "SourceRegistration.h"

namespace domino {

volatile LONG g_objectCount = 0;

namespace {

// Kept from DllMain so self-registration can record where this DLL actually
// lives rather than trusting whatever path the caller typed.
HMODULE g_module = nullptr;

// The binary form of kSourceClsidText from SourceRegistration.h. Both spellings
// exist because COM needs the struct and the registry needs the string.
constexpr GUID kClsidDominoMediaSource = {
    0x6f3b9c2e, 0x1a47, 0x4e58, {0x9d, 0x31, 0x7c, 0x2a, 0x5e, 0x8b, 0x4f, 0x10}};

class ClassFactory : public IClassFactory {
 public:
  ClassFactory() { ModuleAddRef(); }

  IFACEMETHODIMP QueryInterface(REFIID riid, void** ppv) override {
    if (!ppv) return E_POINTER;
    if (riid == __uuidof(IUnknown) || riid == __uuidof(IClassFactory)) {
      *ppv = static_cast<IClassFactory*>(this);
      AddRef();
      return S_OK;
    }
    *ppv = nullptr;
    return E_NOINTERFACE;
  }

  IFACEMETHODIMP_(ULONG) AddRef() override {
    return InterlockedIncrement(&refCount_);
  }

  IFACEMETHODIMP_(ULONG) Release() override {
    ULONG count = InterlockedDecrement(&refCount_);
    if (count == 0) delete this;
    return count;
  }

  IFACEMETHODIMP CreateInstance(IUnknown* outer, REFIID riid,
                                void** ppv) override {
    if (!ppv) return E_POINTER;
    *ppv = nullptr;
    // Aggregation would let a containing object intercept our QueryInterface,
    // and a media source has no use for it.
    if (outer) return CLASS_E_NOAGGREGATION;
    return MediaSource::Create(riid, ppv);
  }

  IFACEMETHODIMP LockServer(BOOL lock) override {
    if (lock) {
      ModuleAddRef();
    } else {
      ModuleRelease();
    }
    return S_OK;
  }

 private:
  ~ClassFactory() { ModuleRelease(); }

  volatile LONG refCount_ = 1;
};

}  // namespace
}  // namespace domino

STDAPI DllGetClassObject(REFCLSID rclsid, REFIID riid, void** ppv) {
  if (!ppv) return E_POINTER;
  *ppv = nullptr;

  if (rclsid != domino::kClsidDominoMediaSource) {
    return CLASS_E_CLASSNOTAVAILABLE;
  }

  auto* factory = new (std::nothrow) domino::ClassFactory();
  if (!factory) return E_OUTOFMEMORY;

  HRESULT hr = factory->QueryInterface(riid, ppv);
  factory->Release();
  return hr;
}

STDAPI DllCanUnloadNow() {
  return domino::g_objectCount == 0 ? S_OK : S_FALSE;
}

/*
 * Self-registration, so `regsvr32 domino_vcam_source.dll` works.
 *
 * This has to write HKEY_LOCAL_MACHINE. The Windows Camera Frame Server runs
 * as NT AUTHORITY\LocalService, and COM resolves an in-proc server against the
 * registry view of the process doing the loading - so a per-user registration
 * under the interactive user is simply invisible to it. That is why turning
 * the camera on needs administrator rights once, and why the installer does it
 * rather than leaving it to the app.
 */
STDAPI DllRegisterServer() {
  wchar_t path[MAX_PATH * 2] = {};
  DWORD length = GetModuleFileNameW(domino::g_module, path, ARRAYSIZE(path));
  if (length == 0 || length >= ARRAYSIZE(path)) {
    return HRESULT_FROM_WIN32(GetLastError());
  }

  LSTATUS status = ERROR_SUCCESS;
  if (!domino::WriteSourceRegistration(HKEY_LOCAL_MACHINE, path, &status)) {
    return HRESULT_FROM_WIN32(status);
  }
  return S_OK;
}

STDAPI DllUnregisterServer() {
  return domino::RemoveSourceRegistration(HKEY_LOCAL_MACHINE)
             ? S_OK
             : HRESULT_FROM_WIN32(ERROR_ACCESS_DENIED);
}

BOOL APIENTRY DllMain(HMODULE module, DWORD reason, LPVOID /*reserved*/) {
  if (reason == DLL_PROCESS_ATTACH) {
    domino::g_module = module;
    // No per-thread state here, and the Frame Server creates threads freely.
    DisableThreadLibraryCalls(module);
  }
  return TRUE;
}
