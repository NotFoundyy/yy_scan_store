import QRCode from 'qrcode';

export const createQrDataUrl = (code: string) =>
  QRCode.toDataURL(code, {
    errorCorrectionLevel: 'M',
    margin: 2,
    width: 960,
    color: {
      dark: '#111827',
      light: '#ffffff',
    },
  });

const loadImage = (src: string) =>
  new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = reject;
    image.src = src;
  });

export const createQrLabelDataUrl = async (input: { code: string; boxName: string }) => {
  const qrDataUrl = await createQrDataUrl(input.code);
  const qrImage = await loadImage(qrDataUrl);
  const canvas = document.createElement('canvas');
  const width = 900;
  const height = 1120;
  const qrSize = 660;
  const canvasContext = canvas.getContext('2d');
  if (!canvasContext) throw new Error('无法生成二维码图片');

  canvas.width = width;
  canvas.height = height;
  canvasContext.fillStyle = '#ffffff';
  canvasContext.fillRect(0, 0, width, height);

  canvasContext.fillStyle = '#0f766e';
  canvasContext.fillRect(0, 0, width, 16);

  canvasContext.fillStyle = '#0f172a';
  canvasContext.textAlign = 'center';
  canvasContext.textBaseline = 'middle';
  canvasContext.font = '700 56px "Microsoft YaHei", sans-serif';
  canvasContext.fillText('老于智慧仓管', width / 2, 96);

  canvasContext.drawImage(qrImage, (width - qrSize) / 2, 172, qrSize, qrSize);

  canvasContext.fillStyle = '#111827';
  canvasContext.font = '700 52px "Microsoft YaHei", sans-serif';
  canvasContext.fillText(input.boxName, width / 2, 908);

  canvasContext.fillStyle = '#475569';
  canvasContext.font = '500 42px ui-monospace, SFMono-Regular, Consolas, monospace';
  canvasContext.fillText(input.code, width / 2, 982);

  canvasContext.strokeStyle = '#d8e0dc';
  canvasContext.lineWidth = 3;
  canvasContext.strokeRect(36, 36, width - 72, height - 72);

  return canvas.toDataURL('image/png');
};
