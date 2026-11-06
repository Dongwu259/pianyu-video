# 内置音效来源说明

本目录全部音效由 `scripts/make-sfx.mjs` **程序化合成**（正弦/噪声振荡器 + 包络 + 确定性
随机种子，单声道 44.1kHz WAV），不包含任何第三方录音素材，无版权负担，可随安装包自由
分发与商用。

- 重新生成：`node scripts/make-sfx.mjs`（确定性输出，同名文件内容一致）。
- 当前清单（32 个变体，2026-09 扩容）：whoosh×6、swish×5、sweep×4、drop×5、
  impact×5、riser×3、click×4。各变体在频宽/时长/明暗/深浅上刻意拉开差距，
  供 sfx-plan 按类别轮换，避免长视频反复同一音色。
- 历史说明：早期版本曾使用 Freesound CC0 公有领域录音批次（`scripts/fetch-cc0-sfx.mjs`
  拉取），后整体替换为程序化合成方案，该批素材已不再随应用分发。
