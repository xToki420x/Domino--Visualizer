// The Media Foundation media source behind the Domino virtual camera.
#pragma once

#include "Precomp.h"

namespace domino {

class MediaStream;

/**
 * Windows instantiates this class inside the Frame Server process when an app
 * opens the Domino camera. It never shares memory with the visualiser by
 * ordinary means, so every frame arrives through the named shared-memory
 * channel that MediaStream reads.
 *
 * IMFMediaSourceEx is required (not merely nice to have) for a software camera
 * source: the Frame Server reads per-stream attributes through it to learn the
 * stream category and that the stream may be shared between clients.
 */
class MediaSource : public IMFMediaSourceEx,
                    public IMFGetService,
                    public IKsControl,
                    public IMFSampleAllocatorControl {
 public:
  static HRESULT Create(REFIID riid, void** ppv);

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

  // IMFMediaSource
  IFACEMETHODIMP CreatePresentationDescriptor(IMFPresentationDescriptor** pd) override;
  IFACEMETHODIMP GetCharacteristics(DWORD* characteristics) override;
  IFACEMETHODIMP Pause() override;
  IFACEMETHODIMP Shutdown() override;
  IFACEMETHODIMP Start(IMFPresentationDescriptor* pd, const GUID* timeFormat,
                       const PROPVARIANT* startPosition) override;
  IFACEMETHODIMP Stop() override;

  // IMFMediaSourceEx
  IFACEMETHODIMP GetSourceAttributes(IMFAttributes** attributes) override;
  IFACEMETHODIMP GetStreamAttributes(DWORD streamId, IMFAttributes** attributes) override;
  IFACEMETHODIMP SetD3DManager(IUnknown* manager) override;

  // IMFGetService
  IFACEMETHODIMP GetService(REFGUID service, REFIID riid, LPVOID* ppv) override;

  // IMFSampleAllocatorControl
  IFACEMETHODIMP SetDefaultAllocator(DWORD outputStreamId,
                                     IUnknown* allocator) override;
  IFACEMETHODIMP GetAllocatorUsage(DWORD outputStreamId, DWORD* inputStreamId,
                                   MFSampleAllocatorUsage* usage) override;

  // IKsControl
  IFACEMETHODIMP KsProperty(PKSPROPERTY property, ULONG propertyLength, void* data,
                            ULONG dataLength, ULONG* bytesReturned) override;
  IFACEMETHODIMP KsMethod(PKSMETHOD method, ULONG methodLength, void* data,
                          ULONG dataLength, ULONG* bytesReturned) override;
  IFACEMETHODIMP KsEvent(PKSEVENT event, ULONG eventLength, void* data,
                         ULONG dataLength, ULONG* bytesReturned) override;

  bool IsShutdown() const { return shutdown_; }

 private:
  MediaSource() = default;
  ~MediaSource();

  HRESULT Initialize();
  HRESULT CheckShutdown() const {
    return shutdown_ ? MF_E_SHUTDOWN : S_OK;
  }

  volatile LONG refCount_ = 1;
  Lock lock_;

  IMFMediaEventQueue* eventQueue_ = nullptr;
  IMFPresentationDescriptor* descriptor_ = nullptr;
  IMFAttributes* attributes_ = nullptr;
  MediaStream* stream_ = nullptr;

  bool mfStarted_ = false;
  bool shutdown_ = false;
  bool streamAnnounced_ = false;
};

}  // namespace domino
