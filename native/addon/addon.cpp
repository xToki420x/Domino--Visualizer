// N-API surface for Domino's virtual camera.
//
// Written against Node-API rather than V8 directly so one compiled binary
// works across Node and Electron versions without an ABI rebuild - which
// matters because Electron upgrades would otherwise break the shipped app.

#include <napi.h>
#include <windows.h>

#include <string>
#include <vector>

#include "FrameChannel.h"
#include "FrameReader.h"
#include "VirtualCamera.h"

namespace {

domino::FrameChannel g_channel;
domino::VirtualCamera g_camera;

std::string Narrow(const std::wstring& wide) {
  if (wide.empty()) return {};
  int bytes = WideCharToMultiByte(CP_UTF8, 0, wide.c_str(),
                                  static_cast<int>(wide.size()), nullptr, 0,
                                  nullptr, nullptr);
  std::string out(static_cast<size_t>(bytes), '\0');
  WideCharToMultiByte(CP_UTF8, 0, wide.c_str(), static_cast<int>(wide.size()),
                      out.data(), bytes, nullptr, nullptr);
  return out;
}

std::wstring Widen(const std::string& narrow) {
  if (narrow.empty()) return {};
  int chars = MultiByteToWideChar(CP_UTF8, 0, narrow.c_str(),
                                  static_cast<int>(narrow.size()), nullptr, 0);
  std::wstring out(static_cast<size_t>(chars), L'\0');
  MultiByteToWideChar(CP_UTF8, 0, narrow.c_str(),
                      static_cast<int>(narrow.size()), out.data(), chars);
  return out;
}

/** Uniform { ok, error? } result, so the JS side never has to catch. */
Napi::Object Result(Napi::Env env, bool ok, const std::wstring& error = {}) {
  Napi::Object obj = Napi::Object::New(env);
  obj.Set("ok", Napi::Boolean::New(env, ok));
  if (!ok) obj.Set("error", Napi::String::New(env, Narrow(error)));
  return obj;
}

Napi::Value RegisterSource(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsString()) {
    return Result(env, false, L"A path to the media source DLL is required");
  }
  std::wstring error;
  const std::wstring path = Widen(info[0].As<Napi::String>().Utf8Value());
  return Result(env, domino::RegisterSourceDll(path, &error), error);
}

Napi::Value UnregisterSource(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  std::wstring error;
  return Result(env, domino::UnregisterSourceDll(&error), error);
}

Napi::Value IsRegistered(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  std::wstring path;
  bool registered = domino::IsSourceRegistered(&path);

  Napi::Object obj = Napi::Object::New(env);
  obj.Set("registered", Napi::Boolean::New(env, registered));
  obj.Set("path", Napi::String::New(env, Narrow(path)));
  return obj;
}

Napi::Value OpenChannel(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  const uint32_t width = info.Length() > 0 && info[0].IsNumber()
                             ? info[0].As<Napi::Number>().Uint32Value() : 1280;
  const uint32_t height = info.Length() > 1 && info[1].IsNumber()
                              ? info[1].As<Napi::Number>().Uint32Value() : 720;
  const uint32_t fps = info.Length() > 2 && info[2].IsNumber()
                           ? info[2].As<Napi::Number>().Uint32Value() : 30;
  std::wstring error;
  return Result(env, g_channel.Open(width, height, fps, 1, &error), error);
}

Napi::Value CloseChannel(const Napi::CallbackInfo& info) {
  g_channel.Close();
  return Result(info.Env(), true);
}

/**
 * Read back the newest frame through the same path the media source will use.
 *
 * Exists so the lock-free protocol can be tested from JS before the DLL
 * depends on it - a torn frame discovered here is far cheaper than one
 * discovered inside the Windows Frame Server.
 */
Napi::Value ReadBackForTest(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  domino::FrameReader reader;
  if (!reader.Open()) {
    return env.Null();
  }
  std::vector<uint8_t> buffer(domino::kMaxFrameBytes);
  uint32_t w = 0, h = 0;
  size_t bytes = reader.ReadLatest(buffer.data(), buffer.size(), &w, &h);
  if (bytes == 0) return env.Null();

  Napi::Object obj = Napi::Object::New(env);
  obj.Set("width", Napi::Number::New(env, w));
  obj.Set("height", Napi::Number::New(env, h));
  obj.Set("heartbeat", Napi::Number::New(env, reader.Heartbeat()));
  obj.Set("data", Napi::Buffer<uint8_t>::Copy(env, buffer.data(), bytes));
  return obj;
}

Napi::Value Start(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  const uint32_t width = info.Length() > 0 && info[0].IsNumber()
                             ? info[0].As<Napi::Number>().Uint32Value() : 1280;
  const uint32_t height = info.Length() > 1 && info[1].IsNumber()
                              ? info[1].As<Napi::Number>().Uint32Value() : 720;
  const uint32_t fps = info.Length() > 2 && info[2].IsNumber()
                           ? info[2].As<Napi::Number>().Uint32Value() : 30;
  const std::wstring name =
      info.Length() > 3 && info[3].IsString()
          ? Widen(info[3].As<Napi::String>().Utf8Value())
          : L"Domino";

  std::wstring error;

  // Shared memory first: the media source may be instantiated the instant the
  // camera is published, and it should find a valid channel waiting.
  if (!g_channel.Open(width, height, fps, 1, &error)) {
    return Result(env, false, error);
  }
  if (!g_camera.Start(name, &error)) {
    g_channel.Close();
    return Result(env, false, error);
  }
  return Result(env, true);
}

Napi::Value Stop(const Napi::CallbackInfo& info) {
  g_camera.Stop();
  g_channel.Close();
  return Result(info.Env(), true);
}

Napi::Value IsRunning(const Napi::CallbackInfo& info) {
  return Napi::Boolean::New(info.Env(), g_camera.IsRunning());
}

/**
 * Publish one NV12 frame.
 *
 * Takes a Buffer and copies it into shared memory synchronously. The copy is a
 * memcpy of about 1.4MB at 720p, which is well under a millisecond and far
 * cheaper than the alternative of handing a JS object to a worker thread.
 */
Napi::Value WriteFrame(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsBuffer()) {
    return Result(env, false, L"A Buffer of NV12 pixel data is required");
  }
  auto buffer = info[0].As<Napi::Buffer<uint8_t>>();
  std::wstring error;
  return Result(env,
                g_channel.WriteFrame(buffer.Data(), buffer.Length(), &error),
                error);
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("registerSource", Napi::Function::New(env, RegisterSource));
  exports.Set("unregisterSource", Napi::Function::New(env, UnregisterSource));
  exports.Set("isRegistered", Napi::Function::New(env, IsRegistered));
  exports.Set("openChannel", Napi::Function::New(env, OpenChannel));
  exports.Set("closeChannel", Napi::Function::New(env, CloseChannel));
  exports.Set("readBackForTest", Napi::Function::New(env, ReadBackForTest));
  exports.Set("start", Napi::Function::New(env, Start));
  exports.Set("stop", Napi::Function::New(env, Stop));
  exports.Set("isRunning", Napi::Function::New(env, IsRunning));
  exports.Set("writeFrame", Napi::Function::New(env, WriteFrame));
  return exports;
}

}  // namespace

NODE_API_MODULE(domino_vcam, Init)
