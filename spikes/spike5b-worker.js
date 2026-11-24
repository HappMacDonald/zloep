onmessage = async e => {
  const bmp = e.data.bmp;
  const oc = new OffscreenCanvas(bmp.width, bmp.height);
  oc.getContext('2d').drawImage(bmp, 0, 0); bmp.close();
  const blob = await oc.convertToBlob({ type: 'image/webp', quality: 1.0 });
  const buf = await blob.arrayBuffer();
  postMessage({ buf }, [buf]);
};
