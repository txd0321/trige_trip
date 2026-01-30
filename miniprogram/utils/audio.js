// utils/audio.js
export function playNoteAudio(noteId) {
  // 若上线后上传音频，可使用 InnerAudioContext 播放云存储地址
  // 现阶段用短震动代替
  wx.vibrateShort({ type: 'medium' });
}
