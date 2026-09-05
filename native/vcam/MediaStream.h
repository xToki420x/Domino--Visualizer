// The single video stream exposed by the Domino virtual camera.
#pragma once

#include "Precomp.h"
#include "FrameReader.h"

namespace domino {

class MediaSource;

/**
 * IMFMediaStream2 rather than plain IMFMediaStream: the Frame Server drives
 * software camera sources through SetStreamState/GetStreamState, and a source
 * that only implements the older interface is accepted at creation and then
 * never asked for frames.
 */
class MediaStream : public IMFMediaStream2 {
 public:
  static HRESULT Create(MediaSource* parent, uint32_t width, uint32_t height,
                        uint32_t fpsNum, uint32_t fpsDen, MediaStream** out);

  // IUnknown
  IFACEMETHODIMP QueryInterface(REFIID riid, void** ppv) override;
  IFACEMETHODIMP_(ULONG) AddRef() override;
  IFACEMETHODIMP_(ULONG) Release() override;

  // IMFMediaEventGenerator
  IFACEMETHODIMP BeginGetEvent(IMFAsyncCallback* callback, IUnknown* state) override;
  IFACEMETHODIMP EndGetEvent(IMFAsyncResult* result, IMFMediaEvent** event) override;
  IFACEMETHODIMP GetEvent(DWORD flags, IMFMediaEvent** event) override;
  IFACEMETHODIMP QueueEvent(MediaEventType type, REFGUID extendedType,
                            HRESULT status, const PROPVARIANT* value) override;

  // IMFMediaStream
  IFACEMETHODIMP GetMediaSource(IMFMediaSource** source) override;
  IFACEMETHODIMP GetStreamDescriptor(IMFStreamDescriptor** descriptor) override;
  IFACEMETHODIMP RequestSample(IUnknown* token) override;

  // IMFMediaStream2
  IFACEMETHODIMP SetStreamState(MF_STREAM_STATE state) override;
  IFACEMETHODIMP GetStreamState(MF_STREAM_STATE* state) override;

  /** Called by the owning source as it moves through its own state machine. */
  HRESULT Start();
  HRESULT Stop();
  void Shutdown();

  IMFStreamDescriptor* Descriptor() const { return descriptor_; }
  HRESULT GetAttributes(IMFAttributes** attributes);

 private:
  MediaStream() = default;
  ~MediaStream();

  HRESULT Initialize(MediaSource* parent, uint32_t width, uint32_t height,
                     uint32_t fpsNum, uint32_t fpsDen);
  HRESULT CreateSample(IUnknown* token, IMFSample** out);
  HRESULT FillBuffer(IMFMediaBuffer* buffer);

  /** Block briefly for a fresh frame so we pace at the declared frame rate. */
  void WaitForNextFrame();

  volatile LONG refCount_ = 1;
  Lock lock_;

  // Weak on purpose: the source owns the stream, and holding a strong
  // reference back would keep both alive forever.
  MediaSource* parent_ = nullptr;

  IMFMediaEventQueue* eventQueue_ = nullptr;
  IMFStreamDescriptor* descriptor_ = nullptr;
  IMFMediaType* mediaType_ = nullptr;

  uint32_t width_ = 0;
  uint32_t height_ = 0;
  uint32_t frameBytes_ = 0;
  LONGLONG frameDuration100ns_ = 0;

  FrameReader reader_;
  uint32_t lastHeartbeat_ = 0;
  BYTE* scratch_ = nullptr;   // holds the most recent frame we managed to read
  bool scratchValid_ = false;

  LONGLONG startTime100ns_ = 0;
  MF_STREAM_STATE state_ = MF_STREAM_STATE_STOPPED;
  bool shutdown_ = false;
};

}  // namespace domino
