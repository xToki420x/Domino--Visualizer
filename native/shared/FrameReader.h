// Consumer side of the shared-memory frame channel.
//
// Header-only and deliberately shared: the media source DLL and the addon's
// self-test both use it, so the lock-free read is written once and the DLL
// inherits code that has already been exercised. Getting a seqlock subtly
// wrong produces torn frames that appear only under load, which is exactly the
// kind of bug that should not be discovered inside the Windows Frame Server.
#pragma once

#include <windows.h>

#include <cstdint>
#include <cstring>

#include "DominoVCamProtocol.h"

namespace domino {

class FrameReader {
 public:
  ~FrameReader() { Close(); }

  FrameReader() = default;
  FrameReader(const FrameReader&) = delete;
  FrameReader& operator=(const FrameReader&) = delete;

  /** Attach to the producer's mapping. False when Domino is not running. */
  bool Open() {
    Close();
    mapping_ = OpenFileMappingW(FILE_MAP_READ, FALSE, kSharedMemoryName);
    if (!mapping_) return false;

    view_ = static_cast<const uint8_t*>(
        MapViewOfFile(mapping_, FILE_MAP_READ, 0, 0, 0));
    if (!view_) {
      Close();
      return false;
    }

    const auto* header = reinterpret_cast<const SharedHeader*>(view_);
    // Magic is written last by the producer, so its presence means the rest of
    // the header is already valid.
    if (header->magic != kMagic || header->version != kVersion) {
      Close();
      return false;
    }

    frameEvent_ = OpenEventW(SYNCHRONIZE, FALSE, kFrameEventName);
    return true;
  }

  void Close() {
    if (view_) {
      UnmapViewOfFile(view_);
      view_ = nullptr;
    }
    if (mapping_) {
      CloseHandle(mapping_);
      mapping_ = nullptr;
    }
    if (frameEvent_) {
      CloseHandle(frameEvent_);
      frameEvent_ = nullptr;
    }
  }

  bool IsOpen() const { return view_ != nullptr; }

  /** True while the producer is still publishing. */
  bool ProducerAlive() const {
    if (!view_) return false;
    return reinterpret_cast<const SharedHeader*>(view_)->magic == kMagic;
  }

  uint32_t Width() const {
    return view_ ? reinterpret_cast<const SharedHeader*>(view_)->width : 0;
  }
  uint32_t Height() const {
    return view_ ? reinterpret_cast<const SharedHeader*>(view_)->height : 0;
  }
  uint32_t Heartbeat() const {
    return view_ ? reinterpret_cast<const SharedHeader*>(view_)->heartbeat : 0;
  }

  /** Block until a new frame or `timeoutMs` elapses. Never required. */
  void WaitForFrame(DWORD timeoutMs) const {
    if (frameEvent_) WaitForSingleObject(frameEvent_, timeoutMs);
  }

  /**
   * Copy the most recent complete frame into `dest`.
   *
   * Returns the byte count, or 0 if nothing stable could be read. Retries a
   * bounded number of times: if the producer is writing faster than we can
   * copy we would rather return the previous frame than spin.
   */
  size_t ReadLatest(uint8_t* dest, size_t destCapacity,
                    uint32_t* outWidth = nullptr,
                    uint32_t* outHeight = nullptr) const {
    if (!view_) return 0;
    const auto* header = reinterpret_cast<const SharedHeader*>(view_);
    if (header->magic != kMagic) return 0;

    for (int attempt = 0; attempt < 8; attempt++) {
      const uint32_t slot = header->latestSlot;
      if (slot >= kSlotCount) return 0;

      const SlotHeader& sh = header->slots[slot];

      const uint32_t before = sh.sequence;
      // Odd means a write is in flight; there is no point copying it.
      if (before & 1u) continue;

      const uint32_t bytes = sh.byteCount;
      const uint32_t w = sh.width;
      const uint32_t h = sh.height;
      if (bytes == 0 || bytes > destCapacity || bytes > kMaxFrameBytes) return 0;

      MemoryBarrier();
      memcpy(dest, view_ + SlotOffset(slot), bytes);
      MemoryBarrier();

      // Unchanged sequence means nothing overwrote the slot mid-copy.
      if (sh.sequence == before) {
        if (outWidth) *outWidth = w;
        if (outHeight) *outHeight = h;
        return bytes;
      }
    }
    return 0;
  }

 private:
  HANDLE mapping_ = nullptr;
  HANDLE frameEvent_ = nullptr;
  const uint8_t* view_ = nullptr;
};

}  // namespace domino
