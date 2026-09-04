#include "VirtualCamera.h"

#include <mfapi.h>

#include <vector>

namespace domino {

// Fixed identity for the Domino media source. Generated once and never
// changed: it is baked into the registry and into the DLL's own registration.
const wchar_t kSourceClsidString[] = L"{6F3B9C2E-1A47-4E58-9D31-7C2A5E8B4F10}";

namespace {

constexpr wchar_t kClsidKey[] =
    L"Software\\Classes\\CLSID\\{6F3B9C2E-1A47-4E58-9D31-7C2A5E8B4F10}";
constexpr wchar_t kInprocKey[] =
    L"Software\\Classes\\CLSID\\{6F3B9C2E-1A47-4E58-9D31-7C2A5E8B4F10}\\InprocServer32";

bool WriteRegString(HKEY root, const wchar_t* subKey, const wchar_t* valueName,
                    const std::wstring& value, std::wstring* error) {
  HKEY key = nullptr;
  LSTATUS status = RegCreateKeyExW(root, subKey, 0, nullptr,
                                   REG_OPTION_NON_VOLATILE, KEY_WRITE, nullptr,
                                   &key, nullptr);
  if (status != ERROR_SUCCESS) {
    if (error) *error = L"Could not create registry key";
    return false;
  }
  status = RegSetValueExW(
      key, valueName, 0, REG_SZ,
      reinterpret_cast<const BYTE*>(value.c_str()),
      static_cast<DWORD>((value.size() + 1) * sizeof(wchar_t)));
  RegCloseKey(key);
  if (status != ERROR_SUCCESS) {
    if (error) *error = L"Could not write registry value";
    return false;
  }
  return true;
}

}  // namespace

bool RegisterSourceDll(const std::wstring& dllPath, std::wstring* error) {
  if (dllPath.empty()) {
    if (error) *error = L"No DLL path given";
    return false;
  }
  if (GetFileAttributesW(dllPath.c_str()) == INVALID_FILE_ATTRIBUTES) {
    if (error) *error = L"The media source DLL was not found at that path";
    return false;
  }

  if (!WriteRegString(HKEY_CURRENT_USER, kClsidKey, nullptr,
                      L"Domino Virtual Camera Source", error)) {
    return false;
  }
  if (!WriteRegString(HKEY_CURRENT_USER, kInprocKey, nullptr, dllPath, error)) {
    return false;
  }
  // Both apartment models are acceptable to the Frame Server; Both is what
  // in-proc media sources normally declare.
  if (!WriteRegString(HKEY_CURRENT_USER, kInprocKey, L"ThreadingModel",
                      L"Both", error)) {
    return false;
  }
  return true;
}

bool UnregisterSourceDll(std::wstring* error) {
  // Delete the subkey first: RegDeleteKey will not remove a key with children.
  RegDeleteKeyW(HKEY_CURRENT_USER, kInprocKey);
  LSTATUS status = RegDeleteKeyW(HKEY_CURRENT_USER, kClsidKey);
  if (status != ERROR_SUCCESS && status != ERROR_FILE_NOT_FOUND) {
    if (error) *error = L"Could not remove the registry key";
    return false;
  }
  return true;
}

bool IsSourceRegistered(std::wstring* registeredPath) {
  HKEY key = nullptr;
  if (RegOpenKeyExW(HKEY_CURRENT_USER, kInprocKey, 0, KEY_READ, &key) !=
      ERROR_SUCCESS) {
    return false;
  }

  wchar_t buffer[MAX_PATH * 2] = {};
  DWORD bytes = sizeof(buffer);
  DWORD type = 0;
  LSTATUS status = RegQueryValueExW(key, nullptr, nullptr, &type,
                                    reinterpret_cast<BYTE*>(buffer), &bytes);
  RegCloseKey(key);

  if (status != ERROR_SUCCESS || type != REG_SZ) return false;
  if (registeredPath) *registeredPath = buffer;

  // A stale registration pointing at a moved or deleted DLL is worse than no
  // registration, because the camera appears and then fails to open.
  return GetFileAttributesW(buffer) != INVALID_FILE_ATTRIBUTES;
}

VirtualCamera::~VirtualCamera() { Stop(); }

bool VirtualCamera::Start(const std::wstring& friendlyName,
                          std::wstring* error) {
  if (camera_) return true;

  if (!mfStarted_) {
    HRESULT hr = MFStartup(MF_VERSION, MFSTARTUP_NOSOCKET);
    if (FAILED(hr)) {
      if (error) *error = L"MFStartup failed";
      return false;
    }
    mfStarted_ = true;
  }

  /*
   * Lifetime is Session, not System: the camera disappears when Domino exits.
   * A virtual camera that outlives the app producing its frames is a device
   * that shows a frozen or black image, which is worse than not being listed.
   */
  HRESULT hr = MFCreateVirtualCamera(
      MFVirtualCameraType_SoftwareCameraSource,
      MFVirtualCameraLifetime_Session,
      MFVirtualCameraAccess_CurrentUser,
      friendlyName.c_str(),
      kSourceClsidString,
      nullptr, 0,
      &camera_);

  if (FAILED(hr)) {
    if (error) {
      // The overwhelmingly common cause is the source DLL not being
      // registered, so say that rather than only printing an HRESULT.
      *error =
          L"MFCreateVirtualCamera failed. The media source is probably not "
          L"registered, or this build of Windows does not support software "
          L"camera sources.";
    }
    camera_.Reset();
    return false;
  }

  hr = camera_->Start(nullptr);
  if (FAILED(hr)) {
    if (error) *error = L"The virtual camera was created but would not start";
    camera_->Remove();
    camera_.Reset();
    return false;
  }

  return true;
}

void VirtualCamera::Stop() {
  if (camera_) {
    camera_->Stop();
    // Remove() unpublishes the device. Without it the entry can linger until
    // the process dies, leaving a camera that produces nothing.
    camera_->Remove();
    camera_.Reset();
  }
  if (mfStarted_) {
    MFShutdown();
    mfStarted_ = false;
  }
}

}  // namespace domino
