#include "FrameChannel.h"

#include <algorithm>

namespace domino {

namespace {

/*
 * Both processes must be able to open the mapping, and the Frame Server does
 * not run as us. A NULL DACL grants access to everyone, which is the standard
 * approach for this kind of session-local channel and is what makes the
 * handoff work at all.
 *
 * The channel carries only rendered visualiser frames - the same pixels
 * already on screen - so there is nothing here that is not already visible to
 * anyone at the machine.
 */
SECURITY_ATTRIBUTES* PermissiveAttributes(SECURITY_ATTRIBUTES* sa,
                                          SECURITY_DESCRIPTOR* sd) {
  if (!InitializeSecurityDescriptor(sd, SECURITY_DESCRIPTOR_REVISION)) {
    return nullptr;
  }
  if (!SetSecurityDescriptorDacl(sd, TRUE, nullptr, FALSE)) {
    return nullptr;
  }
  sa->nLength = sizeof(SECURITY_ATTRIBUTES);
  sa->lpSecurityDescriptor = sd;
  sa->bInheritHandle = FALSE;
  return sa;
}

}  // namespace

FrameChannel::~FrameChannel() { Close(); }

bool FrameChannel::Open(uint32_t width, uint32_t height, uint32_t fpsNum,
                        uint32_t fpsDen, std::wstring* error) {
  Close();

  if (width == 0 || height == 0 || width > kMaxWidth || height > kMaxHeight) {
    if (error) *error = L"Frame size out of range";
    return false;
  }
  // NV12 halves the chroma planes, so odd dimensions have no valid layout.
  if ((width & 1u) || (height & 1u)) {
    if (error) *error = L"NV12 requires even width and height";
    return false;
  }

  SECURITY_ATTRIBUTES sa{};
  SECURITY_DESCRIPTOR sd{};
  SECURITY_ATTRIBUTES* attrs = PermissiveAttributes(&sa, &sd);

  mapping_ = CreateFileMappingW(
      INVALID_HANDLE_VALUE, attrs, PAGE_READWRITE,
      static_cast<DWORD>(kTotalBytes >> 32),
      static_cast<DWORD>(kTotalBytes & 0xFFFFFFFFu), kSharedMemoryName);
  if (!mapping_) {
    if (error) *error = L"CreateFileMapping failed";
    return false;
  }

  view_ = static_cast<uint8_t*>(
      MapViewOfFile(mapping_, FILE_MAP_ALL_ACCESS, 0, 0, 0));
  if (!view_) {
    if (error) *error = L"MapViewOfFile failed";
    Close();
    return false;
  }

  frameEvent_ = CreateEventW(attrs, FALSE /* auto-reset */, FALSE,
                             kFrameEventName);
  if (!frameEvent_) {
    if (error) *error = L"CreateEvent failed";
    Close();
    return false;
  }

  width_ = width;
  height_ = height;
  nextSlot_ = 0;

  auto* header = reinterpret_cast<SharedHeader*>(view_);
  ZeroMemory(header, kHeaderBytes);
  header->width = width;
  header->height = height;
  header->frameRateNum = fpsNum;
  header->frameRateDen = fpsDen;
  header->heartbeat = 0;
  header->latestSlot = 0;
  header->version = kVersion;

  // Magic goes last: a reader that finds it can trust everything above it,
  // which removes any need for a separate "ready" flag.
  MemoryBarrier();
  header->magic = kMagic;

  return true;
}

void FrameChannel::Close() {
  if (view_) {
    // Clear the magic so a consumer stops trusting the contents the moment we
    // go away, rather than serving whatever was left behind.
    auto* header = reinterpret_cast<SharedHeader*>(view_);
    header->magic = 0;
    MemoryBarrier();
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
  width_ = height_ = 0;
}

bool FrameChannel::WriteFrame(const uint8_t* data, size_t bytes,
                              std::wstring* error) {
  if (!view_) {
    if (error) *error = L"Frame channel is not open";
    return false;
  }

  const size_t expected =
      static_cast<size_t>(width_) * height_ * 3 / 2;
  if (bytes != expected) {
    if (error) *error = L"Frame size does not match the declared format";
    return false;
  }

  auto* header = reinterpret_cast<SharedHeader*>(view_);
  const uint32_t slot = nextSlot_;
  SlotHeader& sh = header->slots[slot];

  /*
   * Seqlock write: make the sequence odd, fill the slot, then make it even
   * again. A reader that observes an odd value, or a value that changed while
   * it was copying, knows it raced and retries with another slot.
   *
   * This is why there is no mutex: a cross-process lock would let a stalled
   * consumer block the render loop, and dropping a frame is always better than
   * stuttering the visuals.
   */
  sh.sequence = sh.sequence + 1;  // now odd
  MemoryBarrier();

  memcpy(view_ + SlotOffset(slot), data, bytes);
  sh.byteCount = static_cast<uint32_t>(bytes);
  sh.width = width_;
  sh.height = height_;

  FILETIME ft{};
  GetSystemTimeAsFileTime(&ft);
  sh.timestamp100ns =
      (static_cast<uint64_t>(ft.dwHighDateTime) << 32) | ft.dwLowDateTime;

  MemoryBarrier();
  sh.sequence = sh.sequence + 1;  // even again: stable

  MemoryBarrier();
  header->latestSlot = slot;
  header->heartbeat = header->heartbeat + 1;

  nextSlot_ = (nextSlot_ + 1) % kSlotCount;

  // Wake a consumer that is waiting rather than polling.
  if (frameEvent_) SetEvent(frameEvent_);
  return true;
}

}  // namespace domino
