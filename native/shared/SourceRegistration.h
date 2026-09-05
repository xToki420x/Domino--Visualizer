// COM registration for the Domino media source, shared by both binaries.
//
// The addon writes these keys when the user turns the camera on; the DLL
// writes the same keys when it is self-registered with regsvr32. Keeping one
// implementation means the two can never disagree about the CLSID or the
// value names, which would show up only as a camera that appears and then
// refuses to open.
#pragma once

#include <windows.h>

#include <string>

namespace domino {

/*
 * The identity of the media source. Fixed forever: it is baked into the
 * registry, into the DLL, and into the call to MFCreateVirtualCamera.
 */
inline constexpr wchar_t kSourceClsidText[] =
    L"{6F3B9C2E-1A47-4E58-9D31-7C2A5E8B4F10}";

inline constexpr wchar_t kClsidSubKey[] =
    L"Software\\Classes\\CLSID\\{6F3B9C2E-1A47-4E58-9D31-7C2A5E8B4F10}";
inline constexpr wchar_t kInprocSubKey[] =
    L"Software\\Classes\\CLSID\\{6F3B9C2E-1A47-4E58-9D31-7C2A5E8B4F10}"
    L"\\InprocServer32";

inline bool WriteRegString(HKEY root, const wchar_t* subKey,
                           const wchar_t* valueName, const std::wstring& value,
                           LSTATUS* statusOut = nullptr) {
  HKEY key = nullptr;
  LSTATUS status = RegCreateKeyExW(root, subKey, 0, nullptr,
                                   REG_OPTION_NON_VOLATILE, KEY_WRITE, nullptr,
                                   &key, nullptr);
  if (status != ERROR_SUCCESS) {
    if (statusOut) *statusOut = status;
    return false;
  }
  status = RegSetValueExW(
      key, valueName, 0, REG_SZ, reinterpret_cast<const BYTE*>(value.c_str()),
      static_cast<DWORD>((value.size() + 1) * sizeof(wchar_t)));
  RegCloseKey(key);
  if (statusOut) *statusOut = status;
  return status == ERROR_SUCCESS;
}

/** Register the in-proc server under `root` (HKLM machine-wide, or HKCU). */
inline bool WriteSourceRegistration(HKEY root, const std::wstring& dllPath,
                                    LSTATUS* statusOut = nullptr) {
  if (!WriteRegString(root, kClsidSubKey, nullptr,
                      L"Domino Virtual Camera Source", statusOut)) {
    return false;
  }
  if (!WriteRegString(root, kInprocSubKey, nullptr, dllPath, statusOut)) {
    return false;
  }
  // "Both" is what in-proc media sources declare: the Frame Server may create
  // us from either apartment kind, and refusing one of them would make the
  // camera work for some callers and not others.
  return WriteRegString(root, kInprocSubKey, L"ThreadingModel", L"Both",
                        statusOut);
}

inline bool RemoveSourceRegistration(HKEY root) {
  // The child key goes first - RegDeleteKey will not remove a key that still
  // has subkeys.
  RegDeleteKeyW(root, kInprocSubKey);
  LSTATUS status = RegDeleteKeyW(root, kClsidSubKey);
  return status == ERROR_SUCCESS || status == ERROR_FILE_NOT_FOUND;
}

/** Read back the registered DLL path, if any, from `root`. */
inline bool ReadSourceRegistration(HKEY root, std::wstring* path) {
  HKEY key = nullptr;
  if (RegOpenKeyExW(root, kInprocSubKey, 0, KEY_READ, &key) != ERROR_SUCCESS) {
    return false;
  }

  wchar_t buffer[MAX_PATH * 2] = {};
  DWORD bytes = sizeof(buffer);
  DWORD type = 0;
  LSTATUS status = RegQueryValueExW(key, nullptr, nullptr, &type,
                                    reinterpret_cast<BYTE*>(buffer), &bytes);
  RegCloseKey(key);

  if (status != ERROR_SUCCESS || type != REG_SZ) return false;
  if (path) *path = buffer;

  // A registration pointing at a moved or deleted DLL is worse than none at
  // all, because the camera is listed and then fails when something opens it.
  return GetFileAttributesW(buffer) != INVALID_FILE_ATTRIBUTES;
}

}  // namespace domino
