#include "VirtualCamera.h"

#include <mfapi.h>
#include <shellapi.h>

#include <cstdio>
#include <vector>

#include "SourceRegistration.h"

namespace domino {

namespace {

/**
 * Append the raw HRESULT to a message.
 *
 * Media Foundation failures here are nearly all indistinguishable from the
 * outside - "would not start" covers a missing registration, a source that
 * threw, and a policy refusal alike - so the code has to travel with the text
 * or there is nothing to diagnose from.
 */
std::wstring WithHr(const wchar_t* message, HRESULT hr) {
  wchar_t buffer[64];
  swprintf(buffer, 64, L" (0x%08lX)", static_cast<unsigned long>(hr));
  return std::wstring(message) + buffer;
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

  /*
   * Machine-wide, and only machine-wide.
   *
   * The Windows Camera Frame Server - the process that actually loads this DLL
   * - runs as NT AUTHORITY\LocalService. COM resolves an in-proc server
   * against the registry view of whichever process is loading it, so a
   * per-user registration under the interactive user is invisible there. An
   * earlier version of this wrote HKCU, which registered cleanly and then
   * produced a camera that could never be started.
   */
  LSTATUS status = ERROR_SUCCESS;
  if (WriteSourceRegistration(HKEY_LOCAL_MACHINE, dllPath, &status)) {
    return true;
  }

  if (error) {
    *error =
        status == ERROR_ACCESS_DENIED
            ? L"Registering the virtual camera needs administrator rights. "
              L"The Domino installer does this once at install time."
            : L"Could not write the media source registration";
  }
  return false;
}

bool UnregisterSourceDll(std::wstring* error) {
  const bool machine = RemoveSourceRegistration(HKEY_LOCAL_MACHINE);
  // Also clear the per-user keys: builds before this one wrote them, and a
  // leftover entry pointing at a DLL that has since moved is worse than none.
  RemoveSourceRegistration(HKEY_CURRENT_USER);

  if (!machine && error) {
    *error = L"Removing the registration needs administrator rights";
  }
  return machine;
}

bool RegisterSourceElevated(const std::wstring& dllPath, bool unregister,
                            std::wstring* error) {
  if (dllPath.empty() ||
      GetFileAttributesW(dllPath.c_str()) == INVALID_FILE_ATTRIBUTES) {
    if (error) *error = L"The media source DLL was not found";
    return false;
  }

  // regsvr32 calls DllRegisterServer, which writes the machine-wide keys from
  // inside the DLL itself - so the path on record is always where the DLL
  // really is, even if it was moved since Domino was installed.
  std::wstring arguments = unregister ? L"/s /u \"" : L"/s \"";
  arguments += dllPath;
  arguments += L"\"";

  SHELLEXECUTEINFOW info{};
  info.cbSize = sizeof(info);
  info.fMask = SEE_MASK_NOCLOSEPROCESS | SEE_MASK_NOASYNC;
  info.lpVerb = L"runas";  // the UAC prompt
  info.lpFile = L"regsvr32.exe";
  info.lpParameters = arguments.c_str();
  info.nShow = SW_HIDE;

  if (!ShellExecuteExW(&info)) {
    const DWORD lastError = GetLastError();
    if (error) {
      *error = lastError == ERROR_CANCELLED
                   ? L"Registration was cancelled at the Windows prompt."
                   : L"Could not launch regsvr32.";
    }
    return false;
  }

  if (!info.hProcess) {
    if (error) *error = L"regsvr32 did not start";
    return false;
  }

  // Bounded wait: regsvr32 does a few registry writes, so anything approaching
  // this timeout means it is stuck and waiting longer will not help.
  const DWORD waited = WaitForSingleObject(info.hProcess, 60000);
  DWORD exitCode = 1;
  if (waited == WAIT_OBJECT_0) GetExitCodeProcess(info.hProcess, &exitCode);
  CloseHandle(info.hProcess);

  if (waited != WAIT_OBJECT_0 || exitCode != 0) {
    if (error) *error = WithHr(L"regsvr32 reported a failure", exitCode);
    return false;
  }
  return true;
}

bool IsSourceRegistered(std::wstring* registeredPath) {
  if (ReadSourceRegistration(HKEY_LOCAL_MACHINE, registeredPath)) return true;
  // A user-scoped key is reported as "not registered" on purpose: it exists,
  // but the Frame Server cannot see it, so the camera would not work.
  return false;
}

VirtualCamera::~VirtualCamera() {
  if (thread_.joinable()) {
    Dispatch(Command::Quit, L"", nullptr);
    thread_.join();
  }
}

/* ---------------------- the camera thread and its queue ------------------- */

void VirtualCamera::EnsureThread() {
  if (thread_.joinable()) return;
  thread_ = std::thread([this] { ThreadMain(); });
}

bool VirtualCamera::Dispatch(Command command, const std::wstring& name,
                             std::wstring* error) {
  EnsureThread();

  std::unique_lock<std::mutex> lock(mutex_);
  pending_ = command;
  pendingName_ = name;
  pendingDone_ = false;
  requested_.notify_one();
  finished_.wait(lock, [this] { return pendingDone_; });

  if (error) *error = pendingError_;
  return pendingOk_;
}

void VirtualCamera::ThreadMain() {
  /*
   * The multithreaded apartment is the entire point of this thread. Objects
   * created here are not tied to a message loop, so Windows never has to reach
   * into the application's UI thread to drive the camera.
   */
  HRESULT hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  const bool comReady = SUCCEEDED(hr);

  for (;;) {
    Command command;
    std::wstring name;
    {
      std::unique_lock<std::mutex> lock(mutex_);
      requested_.wait(lock, [this] { return pending_ != Command::None; });
      command = pending_;
      name = pendingName_;
    }

    bool ok = true;
    std::wstring error;
    if (!comReady) {
      ok = false;
      error = L"COM could not be initialised for the camera";
    } else {
      switch (command) {
        case Command::Start:
          ok = StartOnThread(name, false, &error);
          break;
        case Command::Stop:
          TeardownOnThread(true);
          break;
        case Command::Remove: {
          TeardownOnThread(true);
          // Then clear an orphan published by an older build, which needs the
          // same lifetime to get a handle to.
          std::wstring ignored;
          if (StartOnThread(name, true, &ignored)) TeardownOnThread(true);
          break;
        }
        case Command::Quit:
          TeardownOnThread(true);
          break;
        default:
          break;
      }
    }

    {
      std::lock_guard<std::mutex> lock(mutex_);
      pending_ = Command::None;
      pendingOk_ = ok;
      pendingError_ = error;
      pendingDone_ = true;
    }
    finished_.notify_all();

    if (command == Command::Quit) break;
  }

  if (comReady) CoUninitialize();
}

/* ------------------------------ the camera -------------------------------- */

bool VirtualCamera::Start(const std::wstring& friendlyName,
                          std::wstring* error) {
  return Dispatch(Command::Start, friendlyName, error);
}

void VirtualCamera::Stop() { Dispatch(Command::Stop, L"", nullptr); }

void VirtualCamera::RemoveDevice(const std::wstring& friendlyName) {
  Dispatch(Command::Remove, friendlyName, nullptr);
}

bool VirtualCamera::StartOnThread(const std::wstring& friendlyName,
                                  bool persistent, std::wstring* error) {
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
   * Session lifetime. See the note on Start() in the header: a System-lifetime
   * device is listed even when Domino is closed, which sounds strictly better
   * and measurably is not - consumers get zero frames from it whenever Domino
   * is actually publishing. `persistent` is true only when reclaiming an
   * orphan left by the build that shipped that behaviour.
   */
  HRESULT hr = MFCreateVirtualCamera(
      MFVirtualCameraType_SoftwareCameraSource,
      persistent ? MFVirtualCameraLifetime_System
                 : MFVirtualCameraLifetime_Session,
      MFVirtualCameraAccess_CurrentUser,
      friendlyName.c_str(),
      kSourceClsidText,
      nullptr, 0,
      &camera_);

  if (FAILED(hr)) {
    if (error) {
      // The overwhelmingly common cause is the source DLL not being
      // registered, so say that rather than only printing an HRESULT.
      *error = WithHr(
          L"MFCreateVirtualCamera failed. The media source is probably not "
          L"registered, or this build of Windows does not support software "
          L"camera sources.",
          hr);
    }
    camera_.Reset();
    return false;
  }

  /*
   * Retry a service timeout.
   *
   * ERROR_SERVICE_REQUEST_TIMEOUT here means the Windows camera service is
   * still tearing down a previous session - overwhelmingly after a Domino that
   * was killed rather than closed. It clears within a second or two on its
   * own, and the alternative is telling the user their camera does not work
   * when trying again would have fixed it. Bounded tightly, because this runs
   * while someone waits on a toggle.
   */
  hr = camera_->Start(nullptr);
  for (int attempt = 0; attempt < 3 &&
                        hr == HRESULT_FROM_WIN32(ERROR_SERVICE_REQUEST_TIMEOUT);
       attempt++) {
    camera_->Remove();
    camera_.Reset();
    Sleep(900);

    HRESULT again = MFCreateVirtualCamera(
        MFVirtualCameraType_SoftwareCameraSource,
        persistent ? MFVirtualCameraLifetime_System
                   : MFVirtualCameraLifetime_Session,
        MFVirtualCameraAccess_CurrentUser, friendlyName.c_str(),
        kSourceClsidText, nullptr, 0, &camera_);
    if (FAILED(again)) {
      hr = again;
      camera_.Reset();
      break;
    }
    hr = camera_->Start(nullptr);
  }

  if (FAILED(hr)) {
    if (error) {
      /*
       * A service timeout here almost always means the Windows camera service
       * is still tearing down a previous session - most often after a copy of
       * Domino was killed rather than closed. It clears on its own, so say so
       * instead of leaving the user staring at an HRESULT.
       */
      *error =
          hr == HRESULT_FROM_WIN32(ERROR_SERVICE_REQUEST_TIMEOUT)
              ? WithHr(L"The Windows camera service did not respond in time. "
                       L"This usually clears after a few seconds, once any "
                       L"previous copy of Domino has fully exited.",
                       hr)
              : WithHr(L"The virtual camera was created but would not start",
                       hr);
    }
    if (camera_) {
      camera_->Remove();
      camera_.Reset();
    }
    return false;
  }

  running_.store(true);
  return true;
}

void VirtualCamera::TeardownOnThread(bool removeDevice) {
  if (camera_) {
    camera_->Stop();
    // Remove() unpublishes the device. Without it the entry lingers until the
    // process dies, leaving a camera that produces nothing.
    if (removeDevice) camera_->Remove();
    camera_.Reset();
  }
  running_.store(false);
  if (mfStarted_) {
    MFShutdown();
    mfStarted_ = false;
  }
}

}  // namespace domino
