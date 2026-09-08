// Opt-in tracing for the media source.
//
// This code runs inside the Windows Frame Server, a service process we cannot
// attach a debugger to conveniently and whose failures reach us as a single
// opaque HRESULT. A log line is often the only way to tell "Windows never
// loaded us" apart from "Windows loaded us and disliked what it found".
//
// Off unless the marker file exists, so a shipped build writes nothing:
//   type nul > C:\Windows\Temp\domino-vcam-trace
#pragma once

#include <windows.h>

#include <cstdio>

namespace domino {

inline constexpr wchar_t kTraceMarkerPath[] = L"C:\\Windows\\Temp\\domino-vcam-trace";
inline constexpr wchar_t kTraceLogFormat[] =
    L"C:\\Windows\\Temp\\domino-vcam-trace-%lu.log";

inline bool TraceEnabled() {
  // Checked once: the Frame Server can call into us many times a second.
  static const bool enabled =
      GetFileAttributesW(kTraceMarkerPath) != INVALID_FILE_ATTRIBUTES;
  return enabled;
}

/**
 * Append one line, tagged with the process and account we are running as.
 *
 * Those two facts are most of the value: they say whether the Frame Server
 * service loaded us or whether we are only ever being created inside the app
 * that published the camera.
 */
inline void Trace(const char* format, ...) {
  if (!TraceEnabled()) return;

  char message[512] = {};
  va_list args;
  va_start(args, format);
  vsnprintf(message, sizeof(message), format, args);
  va_end(args);

  wchar_t exe[MAX_PATH] = {};
  GetModuleFileNameW(nullptr, exe, ARRAYSIZE(exe));

  wchar_t user[256] = {};
  DWORD userLength = ARRAYSIZE(user);
  if (!GetUserNameW(user, &userLength)) wcscpy_s(user, L"?");

  SYSTEMTIME now{};
  GetLocalTime(&now);

  char line[1200] = {};
  _snprintf_s(line, sizeof(line), _TRUNCATE,
              "%02d:%02d:%02d.%03d  pid=%lu  user=%ls  exe=%ls  %s\r\n",
              now.wHour, now.wMinute, now.wSecond, now.wMilliseconds,
              GetCurrentProcessId(), user, exe, message);

  /*
   * One file per process, because the processes involved run as different
   * accounts. A single shared log is owned by whichever account created it,
   * and the Frame Server - running as LocalService - then silently fails to
   * append, which looks exactly like it never loaded us at all.
   */
  wchar_t logPath[MAX_PATH] = {};
  _snwprintf_s(logPath, ARRAYSIZE(logPath), _TRUNCATE, kTraceLogFormat,
               GetCurrentProcessId());

  // Opened and closed per line, and shared for writing: a handle held open
  // would lock out anything else looking at the file.
  HANDLE file = CreateFileW(logPath, FILE_APPEND_DATA,
                            FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr,
                            OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
  if (file == INVALID_HANDLE_VALUE) return;

  DWORD written = 0;
  WriteFile(file, line, static_cast<DWORD>(strlen(line)), &written, nullptr);
  CloseHandle(file);
}

}  // namespace domino
