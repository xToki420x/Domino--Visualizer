// Common includes and small helpers for the Domino media source DLL.
//
// This binary is loaded by the Windows Frame Server, not by Domino, so it must
// not depend on Node, Electron, or anything else in the app. It talks to the
// running visualiser only through the shared-memory channel described in
// DominoVCamProtocol.h.
#pragma once

#include <windows.h>

#include <mfapi.h>
#include <mferror.h>
#include <mfidl.h>
#include <mfobjects.h>

#include <ks.h>
#include <ksmedia.h>
#include <ksproxy.h>

#include <new>

namespace domino {

/** Total DLL object count. COM may unload us once this reaches zero. */
extern volatile LONG g_objectCount;

inline void ModuleAddRef() { InterlockedIncrement(&g_objectCount); }
inline void ModuleRelease() { InterlockedDecrement(&g_objectCount); }

/**
 * Minimal scoped lock.
 *
 * A media source is called from several Frame Server threads at once - a
 * Start() can overlap a RequestSample() - and the state machine is small
 * enough that one critical section per object is both correct and cheaper to
 * reason about than finer-grained locking.
 */
class Lock {
 public:
  Lock() { InitializeCriticalSection(&cs_); }
  ~Lock() { DeleteCriticalSection(&cs_); }

  Lock(const Lock&) = delete;
  Lock& operator=(const Lock&) = delete;

  void Enter() { EnterCriticalSection(&cs_); }
  void Leave() { LeaveCriticalSection(&cs_); }

 private:
  CRITICAL_SECTION cs_;
};

class Guard {
 public:
  explicit Guard(Lock& lock) : lock_(lock) { lock_.Enter(); }
  ~Guard() { lock_.Leave(); }

  Guard(const Guard&) = delete;
  Guard& operator=(const Guard&) = delete;

 private:
  Lock& lock_;
};

}  // namespace domino
