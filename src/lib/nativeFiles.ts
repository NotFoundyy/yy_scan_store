import { Capacitor } from '@capacitor/core';
import { Directory, Filesystem } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';

export const isNativeApp = () => Capacitor.isNativePlatform();

export const dataUrlToBase64 = (dataUrl: string) => {
  const [, base64] = dataUrl.split(',');
  if (!base64) throw new Error('图片数据无效');
  return base64;
};

export const shareBase64File = async (input: {
  base64: string;
  fileName: string;
  title: string;
  text?: string;
  dialogTitle: string;
}) => {
  const saved = await Filesystem.writeFile({
    path: input.fileName,
    data: input.base64,
    directory: Directory.Cache,
    recursive: true,
  });

  await Share.share({
    title: input.title,
    text: input.text,
    files: [saved.uri],
    dialogTitle: input.dialogTitle,
  });

  return saved.uri;
};

export const saveDataUrlPhotoToGallery = async (input: { dataUrl: string; fileName: string; albumName?: string }) => {
  const { Media } = await import('@capacitor-community/media');
  const albumName = input.albumName ?? '老于智慧仓管';

  try {
    await Media.createAlbum({ name: albumName });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/already exists/i.test(message)) throw error;
  }

  const albums = await Media.getAlbums();
  const album = albums.albums.find((entry) => entry.name === albumName);
  if (!album) throw new Error('未找到二维码相册');

  const fileNameWithoutExt = input.fileName.replace(/\.[^.]+$/, '');
  return Media.savePhoto({
    path: input.dataUrl,
    albumIdentifier: album.identifier,
    fileName: fileNameWithoutExt,
  });
};
