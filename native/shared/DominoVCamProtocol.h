// Shared contract between Domino and the virtual-camera media source.
//
// These two binaries never share an address space: the media source DLL is
// loaded by the Windows Frame Server, in *its* process, and Domino runs in
// Electron. Frames therefore cross through named shared memory, and this
// header is the only thing both sides agree on. Change it and you must
// rebuild both.
#pragma once

#include <cstdint>

namespace domino {

// Session-local, so two users on the same machine get separate channels and
// neither needs elevated rights to create the mapping.
inline constexpr wchar_t kSharedMemoryName[] = L"Local\\DominoVCamFrames_v1";
inline constexpr wchar_t kFrameEventName[] = L"Local\\DominoVCamFrameReady_v1";

inline constexpr uint32_t kMagic = 0x4F4E4D44;  // 'DMNO' little-endian
inline constexpr uint32_t kVersion = 1;

inline constexpr uint32_t kMaxWidth = 1920;
inline constexpr uint32_t kMaxHeight = 1080;

// NV12: a full-resolution Y plane followed by a half-resolution interleaved
// UV plane, so 1.5 bytes per pixel. Chosen because it is what Media Foundation
// camera consumers expect natively - handing over RGB would force a conversion
// somewhere less convenient.
inline constexpr uint32_t kMaxFrameBytes = kMaxWidth * kMaxHeight * 3 / 2;

/*
 * Three slots, written round-robin.
 *
 * Two would be enough to avoid the reader seeing a half-written frame, but a
 * third means the writer never has to wait for a slow reader to let go before
 * it can start the next frame. The visualiser must never block on the camera
 * consumer.
 */
inline constexpr uint32_t kSlotCount = 3;

struct SlotHeader {
  // Seqlock: odd while being written, even when stable. A reader that sees an
  // odd value, or a different value before and after copying, retries.
  volatile uint32_t sequence;
  uint32_t byteCount;
  uint32_t width;
  uint32_t height;
  uint64_t timestamp100ns;
};

struct SharedHeader {
  uint32_t magic;
  uint32_t version;

  uint32_t width;
  uint32_t height;
  uint32_t frameRateNum;
  uint32_t frameRateDen;

  // Bumped by the producer every frame. The media source uses it to notice
  // Domino has gone away and emit black rather than freezing on a stale frame.
  volatile uint32_t heartbeat;
  volatile uint32_t latestSlot;

  SlotHeader slots[kSlotCount];
};

// One page for the header leaves room to add fields later without moving the
// frame data, which would be a breaking change for a mismatched pair.
inline constexpr uint32_t kHeaderBytes = 4096;

inline constexpr uint64_t kTotalBytes =
    static_cast<uint64_t>(kHeaderBytes) +
    static_cast<uint64_t>(kMaxFrameBytes) * kSlotCount;

inline uint64_t SlotOffset(uint32_t slot) {
  return static_cast<uint64_t>(kHeaderBytes) +
         static_cast<uint64_t>(kMaxFrameBytes) * slot;
}

}  // namespace domino
