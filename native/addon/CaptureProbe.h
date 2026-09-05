// Opens the virtual camera the way a real application would.
//
// This exists so the whole path can be verified without Zoom: enumerate camera
// devices through Media Foundation, activate ours, and pull a frame back. If
// that works, the Frame Server has loaded the media source DLL in its own
// process, created the COM class, negotiated NV12 and delivered pixels - which
// is precisely what a conferencing app does.
#pragma once

#include <windows.h>

#include <cstdint>
#include <string>
#include <vector>

namespace domino {

/** Friendly names of every video capture device Media Foundation can see. */
bool EnumerateCameras(std::vector<std::wstring>* names, std::wstring* error);

struct CapturedFrame {
  uint32_t width = 0;
  uint32_t height = 0;
  std::wstring deviceName;
  std::vector<uint8_t> data;  // contiguous NV12
};

/**
 * Open the first camera whose name contains `nameContains` and read one frame.
 *
 * `timeoutMs` bounds the whole attempt, because a source that never produces a
 * sample would otherwise hang the caller rather than reporting a failure.
 */
bool CaptureOneFrame(const std::wstring& nameContains, uint32_t timeoutMs,
                     CapturedFrame* out, std::wstring* error);

struct InterfaceProbe {
  std::wstring name;
  int32_t hr;
};

/**
 * Load the media source DLL directly and report which interfaces its class
 * answers to.
 *
 * Deliberately bypasses the registry: LoadLibrary plus DllGetClassObject is
 * exactly what COM does once it has resolved the CLSID, so this exercises the
 * class factory and the media source without needing the machine-wide
 * registration - which means it runs in CI and on a developer machine without
 * administrator rights. It also isolates a fault: the Frame Server reports one
 * opaque HRESULT when it cannot use our source, and this says whether the
 * object itself is at fault or only its registration.
 */
bool ProbeSourceClass(const std::wstring& dllPath,
                      std::vector<InterfaceProbe>* results, int32_t* createHr,
                      std::wstring* error);

/**
 * Load the media source DLL and pull one frame straight out of it.
 *
 * This drives the source through a real IMFSourceReader - the same component
 * a capture app uses - so Start, RequestSample, the event queue and the NV12
 * buffer layout are all exercised. The only thing it does not cover is the
 * hop through the Windows Frame Server, which no test can arrange without
 * machine-wide registration.
 */
bool CaptureFromDll(const std::wstring& dllPath, uint32_t timeoutMs,
                    CapturedFrame* out, std::wstring* error);

}  // namespace domino
