self.postMessage({
  where: 'worker',
  OffscreenCanvas: typeof OffscreenCanvas,
  ImageDecoder: typeof ImageDecoder,
  subtle: !!(self.crypto && self.crypto.subtle),
  secure: self.isSecureContext
});
