// Registers and publishes the Domino virtual camera with Media Foundation.
#pragma once

#include <windows.h>
#include <mfvirtualcamera.h>
#include <wrl/client.h>

#include <atomic>
#include <condition_variable>
#include <mutex>
#include <string>
#include <thread>

namespace domino {

/**
 * Owns the published camera device.
 *
 * Everything COM here happens on a thread of this class's own, which joins the
 * multithreaded apartment. That is not tidiness - it is the difference between
 * a working camera and a frozen app.
 *
 * Electron's main thread is a single-threaded apartment. A COM object created
 * there belongs to that apartment, and calls into it are delivered through the
 * thread's message loop. Publishing the camera from the main thread therefore
 * put Windows in a position to drive the camera *through Domino's UI thread*,
 * and the moment something streamed from it - a video call, rather than the
 * single frame a test reads - the whole application stopped responding.
 *
 * Frames themselves never come through here: writing one is a memcpy into
 * shared memory with no COM involved, so it stays on the caller's thread.
 */
class VirtualCamera {
 public:
  VirtualCamera() = default;
  ~VirtualCamera();

  VirtualCamera(const VirtualCamera&) = delete;
  VirtualCamera& operator=(const VirtualCamera&) = delete;

  /**
   * Publish the camera. `friendlyName` is what appears in Zoom's device list.
   *
   * Session lifetime: the device exists only while Domino does.
   *
   * A persistent (System lifetime) device was tried, because applications
   * enumerate cameras once at startup and a session camera is therefore
   * invisible to a call that was already open. It does not work. With a
   * persistent device published *and Domino actively producing*, consumers get
   * a ReadSample failure and zero frames - measured against a session camera
   * that streams for minutes without a hiccup in the same harness. Orphaned
   * persistent devices also survive their creator, so a crash left a dead
   * camera in everyone's list.
   */
  bool Start(const std::wstring& friendlyName, std::wstring* error);

  /** Stop and unpublish. Safe to call when not started. */
  void Stop();

  /**
   * Take the device out of the camera list, including an orphan this process
   * did not create.
   *
   * A device left behind by v0.4.0, which published a persistent camera,
   * outlives its creator and nothing here holds a handle to it. Re-creating it
   * *with the same lifetime* yields that handle, and removing it then clears
   * it for good - removing a session device does not touch a system one of the
   * same name, which is why the first attempt at this quietly did nothing.
   */
  void RemoveDevice(const std::wstring& friendlyName);

  bool IsRunning() const { return running_.load(); }

 private:
  enum class Command { None, Start, Stop, Remove, Quit };

  /** Post `command` to the camera thread and wait for it to finish. */
  bool Dispatch(Command command, const std::wstring& name, std::wstring* error);
  void EnsureThread();
  void ThreadMain();

  // Touched only on the camera thread.
  bool StartOnThread(const std::wstring& friendlyName, bool persistent,
                     std::wstring* error);
  void TeardownOnThread(bool removeDevice);
  Microsoft::WRL::ComPtr<IMFVirtualCamera> camera_;
  bool mfStarted_ = false;

  std::thread thread_;
  std::mutex mutex_;
  std::condition_variable requested_;
  std::condition_variable finished_;
  Command pending_ = Command::None;
  std::wstring pendingName_;
  bool pendingOk_ = false;
  std::wstring pendingError_;
  bool pendingDone_ = true;

  std::atomic<bool> running_{false};
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
