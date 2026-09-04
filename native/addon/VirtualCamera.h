// Registers and publishes the Domino virtual camera with Media Foundation.
#pragma once

#include <windows.h>
#include <mfvirtualcamera.h>
#include <wrl/client.h>

#include <string>

namespace domino {

/**
 * CLSID of the media source DLL that Windows loads in the Frame Server.
 *
 * This is a fixed, arbitrary GUID that identifies our source. It must match
 * the one the DLL registers under, or MFCreateVirtualCamera will succeed and
 * then fail to produce frames because the Frame Server cannot instantiate
 * anything.
 */
extern const wchar_t kSourceClsidString[];

class VirtualCamera {
 public:
  VirtualCamera() = default;
  ~VirtualCamera();

  VirtualCamera(const VirtualCamera&) = delete;
  VirtualCamera& operator=(const VirtualCamera&) = delete;

  /** Publish the camera. `friendlyName` is what appears in Zoom's device list. */
  bool Start(const std::wstring& friendlyName, std::wstring* error);

  /** Remove it. Safe to call when not started. */
  void Stop();

  bool IsRunning() const { return camera_ != nullptr; }

 private:
  Microsoft::WRL::ComPtr<IMFVirtualCamera> camera_;
  bool mfStarted_ = false;
};

/**
 * Register the media source DLL under HKCU so the Frame Server can create it.
 *
 * Per-user registration deliberately: it needs no administrator rights, and a
 * visualiser should not be asking for elevation. The trade-off is that the
 * camera exists only for the user who installed it, which is the right default.
 */
bool RegisterSourceDll(const std::wstring& dllPath, std::wstring* error);
bool UnregisterSourceDll(std::wstring* error);

/** True when the DLL is registered and the path on record still exists. */
bool IsSourceRegistered(std::wstring* registeredPath);

}  // namespace domino
