// Producer side of the shared-memory frame channel.
#pragma once

#include <windows.h>

#include <cstdint>
#include <string>

#include "DominoVCamProtocol.h"

namespace domino {

class FrameChannel {
 public:
  FrameChannel() = default;
  ~FrameChannel();

  FrameChannel(const FrameChannel&) = delete;
  FrameChannel& operator=(const FrameChannel&) = delete;

  /** Create (or re-open) the mapping and publish the format. */
  bool Open(uint32_t width, uint32_t height, uint32_t fpsNum, uint32_t fpsDen,
            std::wstring* error);

  void Close();

  bool IsOpen() const { return view_ != nullptr; }

  /**
   * Publish one NV12 frame. `bytes` must be width*height*3/2 for the format
   * declared in Open(). Returns false and sets `error` on a size mismatch.
   */
  bool WriteFrame(const uint8_t* data, size_t bytes, std::wstring* error);

  uint32_t Width() const { return width_; }
  uint32_t Height() const { return height_; }

 private:
  HANDLE mapping_ = nullptr;
  HANDLE frameEvent_ = nullptr;
  uint8_t* view_ = nullptr;

  uint32_t width_ = 0;
  uint32_t height_ = 0;
  uint32_t nextSlot_ = 0;
};

}  // namespace domino
