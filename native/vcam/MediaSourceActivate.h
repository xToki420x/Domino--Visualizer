// The activation object Windows actually creates from our CLSID.
#pragma once

#include "Precomp.h"

namespace domino {

/**
 * What the registered CLSID resolves to.
 *
 * Windows does not create a media source from a virtual camera CLSID - it
 * creates an *activate* object and calls ActivateObject on it when a client
 * opens the camera. This indirection is what lets the Frame Server hold a
 * cheap handle to every registered camera without instantiating any of them,
 * and it is the reason a class that only implements IMFMediaSource is created
 * successfully and then rejected with a bare E_NOINTERFACE.
 *
 * IMFActivate derives from IMFAttributes, so most of this class is forwarding
 * to a store Media Foundation creates for us. Windows writes configuration
 * into that store before activating, which is the other half of why the
 * indirection exists.
 */
class MediaSourceActivate : public IMFActivate {
 public:
  static HRESULT Create(REFIID riid, void** ppv);

  // IUnknown
  IFACEMETHODIMP QueryInterface(REFIID riid, void** ppv) override;
  IFACEMETHODIMP_(ULONG) AddRef() override;
  IFACEMETHODIMP_(ULONG) Release() override;

  // IMFActivate
  IFACEMETHODIMP ActivateObject(REFIID riid, void** ppv) override;
  IFACEMETHODIMP ShutdownObject() override;
  IFACEMETHODIMP DetachObject() override;

  // IMFAttributes - every one of these forwards to `attributes_`.
  IFACEMETHODIMP GetItem(REFGUID key, PROPVARIANT* value) override;
  IFACEMETHODIMP GetItemType(REFGUID key, MF_ATTRIBUTE_TYPE* type) override;
  IFACEMETHODIMP CompareItem(REFGUID key, REFPROPVARIANT value, BOOL* result) override;
  IFACEMETHODIMP Compare(IMFAttributes* other, MF_ATTRIBUTES_MATCH_TYPE type,
                         BOOL* result) override;
  IFACEMETHODIMP GetUINT32(REFGUID key, UINT32* value) override;
  IFACEMETHODIMP GetUINT64(REFGUID key, UINT64* value) override;
  IFACEMETHODIMP GetDouble(REFGUID key, double* value) override;
  IFACEMETHODIMP GetGUID(REFGUID key, GUID* value) override;
  IFACEMETHODIMP GetStringLength(REFGUID key, UINT32* length) override;
  IFACEMETHODIMP GetString(REFGUID key, LPWSTR value, UINT32 size,
                           UINT32* length) override;
  IFACEMETHODIMP GetAllocatedString(REFGUID key, LPWSTR* value, UINT32* length) override;
  IFACEMETHODIMP GetBlobSize(REFGUID key, UINT32* size) override;
  IFACEMETHODIMP GetBlob(REFGUID key, UINT8* buffer, UINT32 bufferSize,
                         UINT32* blobSize) override;
  IFACEMETHODIMP GetAllocatedBlob(REFGUID key, UINT8** buffer, UINT32* size) override;
  IFACEMETHODIMP GetUnknown(REFGUID key, REFIID riid, LPVOID* ppv) override;
  IFACEMETHODIMP SetItem(REFGUID key, REFPROPVARIANT value) override;
  IFACEMETHODIMP DeleteItem(REFGUID key) override;
  IFACEMETHODIMP DeleteAllItems() override;
  IFACEMETHODIMP SetUINT32(REFGUID key, UINT32 value) override;
  IFACEMETHODIMP SetUINT64(REFGUID key, UINT64 value) override;
  IFACEMETHODIMP SetDouble(REFGUID key, double value) override;
  IFACEMETHODIMP SetGUID(REFGUID key, REFGUID value) override;
  IFACEMETHODIMP SetString(REFGUID key, LPCWSTR value) override;
  IFACEMETHODIMP SetBlob(REFGUID key, const UINT8* buffer, UINT32 size) override;
  IFACEMETHODIMP SetUnknown(REFGUID key, IUnknown* unknown) override;
  IFACEMETHODIMP LockStore() override;
  IFACEMETHODIMP UnlockStore() override;
  IFACEMETHODIMP GetCount(UINT32* count) override;
  IFACEMETHODIMP GetItemByIndex(UINT32 index, GUID* key, PROPVARIANT* value) override;
  IFACEMETHODIMP CopyAllItems(IMFAttributes* dest) override;

 private:
  MediaSourceActivate() = default;
  ~MediaSourceActivate();

  HRESULT Initialize();

  volatile LONG refCount_ = 1;
  Lock lock_;

  IMFAttributes* attributes_ = nullptr;
  /**
   * Created on first activation and handed back on every one after.
   *
   * Held as the interface rather than the concrete class so this file needs
   * to know nothing about how the source is built.
   */
  IMFMediaSourceEx* source_ = nullptr;
};

}  // namespace domino
