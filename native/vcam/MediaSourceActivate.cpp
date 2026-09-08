#include "MediaSourceActivate.h"

#include "MediaSource.h"
#include "Trace.h"

namespace domino {

HRESULT MediaSourceActivate::Create(REFIID riid, void** ppv) {
  if (!ppv) return E_POINTER;
  *ppv = nullptr;

  auto* activate = new (std::nothrow) MediaSourceActivate();
  if (!activate) return E_OUTOFMEMORY;

  HRESULT hr = activate->Initialize();
  if (SUCCEEDED(hr)) hr = activate->QueryInterface(riid, ppv);
  activate->Release();
  return hr;
}

MediaSourceActivate::~MediaSourceActivate() {
  if (source_) source_->Release();
  if (attributes_) attributes_->Release();
  ModuleRelease();
}

HRESULT MediaSourceActivate::Initialize() {
  ModuleAddRef();
  // Media Foundation supplies the store, so attribute semantics - blob
  // copying, item types, locking - are its problem rather than ours.
  return MFCreateAttributes(&attributes_, 4);
}

// --- IUnknown ---------------------------------------------------------------

IFACEMETHODIMP MediaSourceActivate::QueryInterface(REFIID riid, void** ppv) {
  if (!ppv) return E_POINTER;
  if (riid == __uuidof(IUnknown) || riid == __uuidof(IMFAttributes) ||
      riid == __uuidof(IMFActivate)) {
    *ppv = static_cast<IMFActivate*>(this);
    AddRef();
    return S_OK;
  }
  *ppv = nullptr;
  return E_NOINTERFACE;
}

IFACEMETHODIMP_(ULONG) MediaSourceActivate::AddRef() {
  return InterlockedIncrement(&refCount_);
}

IFACEMETHODIMP_(ULONG) MediaSourceActivate::Release() {
  ULONG count = InterlockedDecrement(&refCount_);
  if (count == 0) delete this;
  return count;
}

// --- IMFActivate ------------------------------------------------------------

IFACEMETHODIMP MediaSourceActivate::ActivateObject(REFIID riid, void** ppv) {
  if (!ppv) return E_POINTER;
  *ppv = nullptr;

  Guard guard(lock_);

  /*
   * The same instance every time until it is shut down or detached. Media
   * Foundation relies on that: it activates once to inspect the source and
   * again to use it, and handing back two different sources would leave the
   * second one wired to nothing.
   */
  if (!source_) {
    IMFMediaSourceEx* created = nullptr;
    HRESULT hr = MediaSource::Create(IID_PPV_ARGS(&created));
    Trace("MediaSourceActivate::ActivateObject created source -> 0x%08lX", hr);
    if (FAILED(hr)) return hr;
    source_ = created;
  }
  return source_->QueryInterface(riid, ppv);
}

IFACEMETHODIMP MediaSourceActivate::ShutdownObject() {
  Guard guard(lock_);
  if (source_) {
    source_->Shutdown();
    source_->Release();
    source_ = nullptr;
  }
  return S_OK;
}

IFACEMETHODIMP MediaSourceActivate::DetachObject() {
  // Let go without shutting down: the caller is taking ownership of a source
  // that is still expected to work.
  Guard guard(lock_);
  if (source_) {
    source_->Release();
    source_ = nullptr;
  }
  return S_OK;
}

/*
 * Everything below is pure delegation to the attribute store.
 *
 * IMFAttributes is thirty methods of the same shape, and writing them out by
 * hand would be thirty chances to forward the wrong argument. The macro makes
 * the one thing that matters - that each is a straight pass-through, with no
 * behaviour of our own - impossible to miss.
 */
#define DOMINO_FORWARD(signature, call)                     \
  IFACEMETHODIMP MediaSourceActivate::signature {           \
    return attributes_ ? attributes_->call : E_UNEXPECTED;  \
  }

DOMINO_FORWARD(GetItem(REFGUID key, PROPVARIANT* value), GetItem(key, value))
DOMINO_FORWARD(GetItemType(REFGUID key, MF_ATTRIBUTE_TYPE* type),
               GetItemType(key, type))
DOMINO_FORWARD(CompareItem(REFGUID key, REFPROPVARIANT value, BOOL* result),
               CompareItem(key, value, result))
DOMINO_FORWARD(Compare(IMFAttributes* other, MF_ATTRIBUTES_MATCH_TYPE type,
                       BOOL* result),
               Compare(other, type, result))
DOMINO_FORWARD(GetUINT32(REFGUID key, UINT32* value), GetUINT32(key, value))
DOMINO_FORWARD(GetUINT64(REFGUID key, UINT64* value), GetUINT64(key, value))
DOMINO_FORWARD(GetDouble(REFGUID key, double* value), GetDouble(key, value))
DOMINO_FORWARD(GetGUID(REFGUID key, GUID* value), GetGUID(key, value))
DOMINO_FORWARD(GetStringLength(REFGUID key, UINT32* length),
               GetStringLength(key, length))
DOMINO_FORWARD(GetString(REFGUID key, LPWSTR value, UINT32 size, UINT32* length),
               GetString(key, value, size, length))
DOMINO_FORWARD(GetAllocatedString(REFGUID key, LPWSTR* value, UINT32* length),
               GetAllocatedString(key, value, length))
DOMINO_FORWARD(GetBlobSize(REFGUID key, UINT32* size), GetBlobSize(key, size))
DOMINO_FORWARD(GetBlob(REFGUID key, UINT8* buffer, UINT32 bufferSize,
                       UINT32* blobSize),
               GetBlob(key, buffer, bufferSize, blobSize))
DOMINO_FORWARD(GetAllocatedBlob(REFGUID key, UINT8** buffer, UINT32* size),
               GetAllocatedBlob(key, buffer, size))
DOMINO_FORWARD(GetUnknown(REFGUID key, REFIID riid, LPVOID* ppv),
               GetUnknown(key, riid, ppv))
DOMINO_FORWARD(SetItem(REFGUID key, REFPROPVARIANT value), SetItem(key, value))
DOMINO_FORWARD(DeleteItem(REFGUID key), DeleteItem(key))
DOMINO_FORWARD(DeleteAllItems(), DeleteAllItems())
DOMINO_FORWARD(SetUINT32(REFGUID key, UINT32 value), SetUINT32(key, value))
DOMINO_FORWARD(SetUINT64(REFGUID key, UINT64 value), SetUINT64(key, value))
DOMINO_FORWARD(SetDouble(REFGUID key, double value), SetDouble(key, value))
DOMINO_FORWARD(SetGUID(REFGUID key, REFGUID value), SetGUID(key, value))
DOMINO_FORWARD(SetString(REFGUID key, LPCWSTR value), SetString(key, value))
DOMINO_FORWARD(SetBlob(REFGUID key, const UINT8* buffer, UINT32 size),
               SetBlob(key, buffer, size))
DOMINO_FORWARD(SetUnknown(REFGUID key, IUnknown* unknown),
               SetUnknown(key, unknown))
DOMINO_FORWARD(LockStore(), LockStore())
DOMINO_FORWARD(UnlockStore(), UnlockStore())
DOMINO_FORWARD(GetCount(UINT32* count), GetCount(count))
DOMINO_FORWARD(GetItemByIndex(UINT32 index, GUID* key, PROPVARIANT* value),
               GetItemByIndex(index, key, value))
DOMINO_FORWARD(CopyAllItems(IMFAttributes* dest), CopyAllItems(dest))

#undef DOMINO_FORWARD

}  // namespace domino
