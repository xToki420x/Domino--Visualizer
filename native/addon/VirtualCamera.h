// Registers and publishes the Domino virtual camera with Media Foundation.
#pragma once

#include <windows.h>
#include <mfvirtualcamera.h>
#include <wrl/client.h>

#include <string>

namespace domino {

class VirtualCamera {
 public:
  VirtualCamera() = default;
  ~VirtualCamera();

  VirtualCamera(const VirtualCamera&) = delete;
  VirtualCamera& operator=(const VirtualCamera&) = delete;

  /**
   * Publish the camera. `friendlyName` is what appears in Zoom's device list.
   *
   * `persistent` keeps the device registered when Domino is not running, the
   * way every other virtual camera on a typical machine behaves. It matters
   * because applications enumerate cameras once, at startup: a camera that
   * only exists while Domino happens to be open is invisible to a call that
   * was already running, which is the single most common way this feature
   * looks broken.
   */
  bool Start(const std::wstring& friendlyName, bool persistent,
             std::wstring* error);

  /**
   * Stop producing frames.
   *
   * A persistent camera stays in the device list afterwards, showing black -
   * that is the whole point of it, and deleting the device here would put us
   * back to being invisible to any call that was already open.
   */
  void Stop();

  /**
   * Unpublish the device outright.
   *
   * Separate from Stop() because it is not reversible from another
   * application's point of view: anything that had Domino selected loses the
   * device. Used when the driver is unregistered.
   */
  void RemoveDevice();

  /** True while the device is published, whether or not frames are flowing. */
  bool IsRunning() const { return camera_ != nullptr; }

 private:
  void Teardown(bool removeDevice);

  Microsoft::WRL::ComPtr<IMFVirtualCamera> camera_;
  bool mfStarted_ = false;
  bool persistent_ = false;
};

/**
 * Register the media source DLL machine-wide so the Frame Server can create it.
 *
 * This needs administrator rights, which is not a choice: the Frame Server
 * runs as LocalService and cannot see a per-user registration. The installer
 * does it once, so the app itself never has to ask for elevation.
 */
bool RegisterSourceDll(const std::wstring& dllPath, std::wstring* error);
bool UnregisterSourceDll(std::wstring* error);

/**
 * Ask Windows to run regsvr32 elevated against the media source DLL.
 *
 * Registration needs administrator rights, and the honest way to get them is
 * one visible UAC prompt for a standard Windows command the user can recognise
 * - not a silently elevated helper, and not forcing every install to run as
 * administrator for a feature most people will never turn on.
 *
 * Returns false if the user declines the prompt, which is a normal outcome
 * rather than an error worth shouting about.
 */
bool RegisterSourceElevated(const std::wstring& dllPath, bool unregister,
                            std::wstring* error);

/** True when the DLL is registered machine-wide and that path still exists. */
bool IsSourceRegistered(std::wstring* registeredPath);

}  // namespace domino
