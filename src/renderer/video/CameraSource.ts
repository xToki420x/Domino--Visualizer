/**
 * Webcam capture, exposed to shaders as a texture.
 *
 * Deliberately mirrors AudioEngine's shape: it owns the device, keeps a
 * texture that is always safe to bind, and exposes a status other code can
 * subscribe to. Callers never have to check whether a camera is running before
 * sampling - the texture exists from construction and simply holds black until
 * frames arrive.
 */

export interface CameraStatus {
  active: boolean;
  label: string;
  width: number;
  height: number;
  error?: string;
}

export class CameraSource {
  private gl: WebGL2RenderingContext;
  readonly texture: WebGLTexture;

  private video: HTMLVideoElement | null = null;
  private stream: MediaStream | null = null;

  /** Set when the browser tells us a fresh frame is ready to upload. */
  private frameReady = true;
  private frameCallbackHandle: number | null = null;

  private status: CameraStatus = { active: false, label: '', width: 0, height: 0 };
  private listeners = new Set<(s: CameraStatus) => void>();

  /** Horizontal flip, for a selfie-style view. */
  mirror = true;

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;

    const tex = gl.createTexture();
    if (!tex) throw new Error('Could not create camera texture');
    this.texture = tex;

    // 1x1 black placeholder so the texture is bindable before any frame lands.
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(
      gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
      new Uint8Array([0, 0, 0, 255]),
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    // Clamp, not repeat: a shader sampling outside 0..1 should see the edge
    // rather than the far side of your face.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  onStatus(cb: (s: CameraStatus) => void): () => void {
    this.listeners.add(cb);
    cb(this.status);
    return () => this.listeners.delete(cb);
  }

  private setStatus(next: CameraStatus): void {
    this.status = next;
    for (const cb of this.listeners) cb(next);
  }

  getStatus(): CameraStatus {
    return this.status;
  }

  get active(): boolean {
    return this.status.active;
  }

  async listDevices(): Promise<MediaDeviceInfo[]> {
    // Labels stay blank until camera permission has been granted once.
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter((d) => d.kind === 'videoinput');
  }

  async start(deviceId?: string): Promise<void> {
    this.stop();

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: deviceId
          ? { deviceId: { exact: deviceId } }
          : { width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });

      const video = document.createElement('video');
      video.autoplay = true;
      video.muted = true;
      video.playsInline = true;
      video.srcObject = stream;
      await video.play();

      this.stream = stream;
      this.video = video;

      const track = stream.getVideoTracks()[0];
      const settings = track?.getSettings?.() ?? {};

      // A camera can be unplugged or grabbed by another app mid-session.
      track?.addEventListener('ended', () => this.handleTrackEnded());

      this.scheduleFrameCallback();

      this.setStatus({
        active: true,
        label: track?.label || 'Camera',
        width: settings.width ?? video.videoWidth,
        height: settings.height ?? video.videoHeight,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.setStatus({ active: false, label: '', width: 0, height: 0, error: message });
      throw err;
    }
  }

  private handleTrackEnded(): void {
    this.stop();
    this.setStatus({
      active: false,
      label: '',
      width: 0,
      height: 0,
      error: 'The camera stopped. It may have been unplugged or taken by another app.',
    });
  }

  /**
   * Upload only when the browser reports a new frame.
   *
   * A webcam runs at 30fps while the visualizer runs at 60+, so uploading
   * every render frame would copy the same pixels twice for no reason.
   * requestVideoFrameCallback tells us exactly when that is worth doing.
   */
  private scheduleFrameCallback(): void {
    const video = this.video as (HTMLVideoElement & {
      requestVideoFrameCallback?: (cb: () => void) => number;
    }) | null;
    if (!video?.requestVideoFrameCallback) {
      // Older engines: fall back to uploading every frame.
      this.frameReady = true;
      return;
    }
    this.frameCallbackHandle = video.requestVideoFrameCallback(() => {
      this.frameReady = true;
      if (this.video) this.scheduleFrameCallback();
    });
  }

  /** Call once per render frame, before binding the texture. */
  update(): void {
    const video = this.video;
    if (!video || !this.status.active) return;
    if (video.readyState < 2 /* HAVE_CURRENT_DATA */) return;

    const supportsCallback = 'requestVideoFrameCallback' in video;
    if (supportsCallback && !this.frameReady) return;
    this.frameReady = false;

    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    // Video frames arrive top-down; GL textures are bottom-up. Flipping here
    // means shaders sample the camera the right way up with no extra uniform.
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    try {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
    } catch {
      // A frame can be unavailable for a tick during device changes; skipping
      // is correct and the previous frame stays on screen.
    }
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);

    if (video.videoWidth && video.videoWidth !== this.status.width) {
      this.setStatus({ ...this.status, width: video.videoWidth, height: video.videoHeight });
    }
  }

  stop(): void {
    if (this.frameCallbackHandle !== null) {
      const video = this.video as (HTMLVideoElement & {
        cancelVideoFrameCallback?: (h: number) => void;
      }) | null;
      video?.cancelVideoFrameCallback?.(this.frameCallbackHandle);
      this.frameCallbackHandle = null;
    }
    if (this.stream) {
      for (const track of this.stream.getTracks()) track.stop();
      this.stream = null;
    }
    if (this.video) {
      this.video.pause();
      this.video.srcObject = null;
      this.video = null;
    }
    if (this.status.active) {
      this.setStatus({ active: false, label: '', width: 0, height: 0 });
    }
  }

  dispose(): void {
    this.stop();
    this.gl.deleteTexture(this.texture);
    this.listeners.clear();
  }
}
