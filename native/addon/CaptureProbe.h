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

/**
 * Can Media Foundation start on this machine at all?
 *
 * Windows Server, and therefore most CI runners, ships without the Media
 * Foundation feature. Everything camera-related is then unavailable through no
 * fault of the build, and a test suite has to tell that apart from a genuine
 * regression instead of reporting a red build either way.
 */
bool MediaFoundationAvailable();

/** Friendly names of every video capture device Media Foundation can see. */
bool EnumerateCameras(std::vector<std::wstring>* names, std::wstring* error);

/**
 * The same question asked through DirectShow instead.
 *
 * Plenty of conferencing and streaming applications still enumerate cameras
 * the old way. Windows bridges Media Foundation virtual cameras into DirectShow
 * automatically, but "automatically" is worth verifying: a camera that appears
 * in one list and not the other looks, to the user, like an app that refuses to
 * see it for no reason.
 */
bool EnumerateDirectShowCameras(std::vector<std::wstring>* names,
                                std::wstring* error);

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

struct StreamStats {
  uint32_t frames = 0;
  uint32_t emptyReads = 0;
  uint32_t width = 0;
  uint32_t height = 0;
  uint32_t longestGapMs = 0;
  uint32_t elapsedMs = 0;
  bool endOfStream = false;
};

/**
 * Hold the camera open and pull frames for a while, the way a call does.
 *
 * Reading a single frame proves the pipe connects; it says nothing about what
 * happens over minutes of streaming, which is where a leak, a stall or a
 * deadlock between producer and consumer would actually show up.
 */
bool StreamFromCamera(const std::wstring& nameContains, uint32_t durationMs,
                      StreamStats* stats, std::wstring* error);

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
