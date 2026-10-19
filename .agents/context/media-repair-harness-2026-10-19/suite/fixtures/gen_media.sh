#!/bin/sh
# Deterministic synthetic media generator for the media repair harness dev suite (dev-v1).
# Runs in a CPU-limited batch Job (ffmpeg 8.1.2 from the audiobookshelf image; see suite/README.md).
# Everything is lavfi-synthetic (testsrc2, sine); nothing here is copyrighted media. Works named here are fictional.
# Output: ./out/media/*, ./out/probes/*.probe.json|err|rc, ./out/decode/*.ss<N>.prog|err|rc, ./out/SHA256SUMS
# Note: Matroska output embeds a random SegmentUID, so .mkv bytes differ between runs even with -fflags +bitexact;
# m4b, mp3 and mp4 outputs are byte-identical across runs. The committed files and their hashes are the authority.
set -u
ulimit -f 20000   # 10 MB per file: a runaway encoder fails instead of filling the disk
FONT=$(ls /app/client/dist/_nuxt/fonts/UbuntuMono-Regular.*.ttf | head -1)
FF="nice -n 19 ffmpeg -nostdin -y -hide_banner -loglevel error -threads 1 -fflags +bitexact -flags +bitexact"
mkdir -p out/media out/probes out/decode out/tmp
cd out

# card <text> <enable-expr> <y>: one drawtext line of a title card
card() { printf "drawtext=fontfile=%s:text='%s':fontsize=22:fontcolor=white:x=(w-text_w)/2:y=%s:box=1:boxcolor=black@0.85:enable='%s'" "$FONT" "$1" "$3" "$2"; }

# vid <name> <dur> <freq> <vfilter-suffix> <metafile> <extra-ffmpeg-args...>
vid() {
  name=$1; dur=$2; freq=$3; vf=$4; meta=$5; shift 5
  base="testsrc2=size=256x192:rate=10:duration=${dur}"
  [ -n "$vf" ] && base="${base},${vf}"
  $FF -f lavfi -i "$base" -f lavfi -i "sine=frequency=${freq}:sample_rate=22050:duration=${dur}" \
      -f ffmetadata -i "$meta" -map 0:v -map 1:a -map_metadata 2 -map_chapters 2 \
      -c:v libx264 -preset veryfast -crf 40 -g 20 -pix_fmt yuv420p -c:a aac -b:a 24k -ac 1 "$@" "media/$name"
}
meta_ep() { # file show title season ep ch1end dur
  { echo ";FFMETADATA1"; echo "title=$2"; echo "show=$3"; echo "season_number=$4"; echo "episode_sort=$5"
    echo "[CHAPTER]"; echo "TIMEBASE=1/1000"; echo "START=0"; echo "END=$6"; echo "title=Cold open"
    echo "[CHAPTER]"; echo "TIMEBASE=1/1000"; echo "START=$6"; echo "END=$7"; echo "title=$2"; } > "$1"
}
meta_plain() { { echo ";FFMETADATA1"; echo "title=$2"; } > "$1"; }
card3() { # line1 line2 line3 enable
  c1=$(card "$1" "$4" 50); c2=$(card "$2" "$4" 90); c3=$(card "$3" "$4" 130); echo "$c1,$c2,$c3"; }

echo STEP tv >&2
# ---- TV (fictional series "Harbor Lights"; aired order E01 Low Tide, E02 Lamp Oil, E03 The Salt Wind, E04 Night Ferry, E05 The Glass Harbor, E06 Gull Rock)
meta_ep t_e03.txt "The Salt Wind" "Harbor Lights" 1 3 2000 8000
vid hl_e03.mkv 8 330 "$(card3 'HARBOR LIGHTS' 'S01E03' 'THE SALT WIND' 'lt(t,2)')" t_e03.txt
meta_ep t_e02.txt "Lamp Oil" "Harbor Lights" 1 2 2000 8000
vid hl_e02_good.mkv 8 300 "$(card3 'HARBOR LIGHTS' 'S01E02' 'LAMP OIL' 'lt(t,2)')" t_e02.txt
meta_ep t_e04.txt "Night Ferry" "Harbor Lights" 1 4 2000 8000
vid hl_e04_nightferry.mkv 8 360 "$(card3 'HARBOR LIGHTS' 'S01E04' 'NIGHT FERRY' 'lt(t,2)')" t_e04.txt
# glass harbor: title card names the episode but carries no number (as many shows do); no episode_sort tag
{ echo ";FFMETADATA1"; echo "title=The Glass Harbor"; echo "show=Harbor Lights"; } > t_gh.txt
vid hl_glass_harbor.mkv 8 390 "$(card 'HARBOR LIGHTS' 'lt(t,2)' 70),$(card 'THE GLASS HARBOR' 'lt(t,2)' 110)" t_gh.txt
# generic scene: no title card, no episode tags, no chapters
meta_plain t_gen.txt ""
vid hl_generic.mkv 8 270 "" t_gen.txt
# multi-stream healthy file: second audio track (commentary) and a subtitle track
meta_ep t_e01.txt "Low Tide" "Harbor Lights" 1 1 2000 8000
printf '1\n00:00:00,500 --> 00:00:01,900\nThe tide goes out at six.\n\n2\n00:00:03,000 --> 00:00:05,000\nHold the line, Marta.\n\n' > t_e01.srt
$FF -f lavfi -i "testsrc2=size=256x192:rate=10:duration=8,$(card3 'HARBOR LIGHTS' 'S01E01' 'LOW TIDE' 'lt(t,2)')" \
    -f lavfi -i "sine=frequency=250:sample_rate=22050:duration=8" -f lavfi -i "sine=frequency=500:sample_rate=22050:duration=8" \
    -i t_e01.srt -f ffmetadata -i t_e01.txt -map 0:v -map 1:a -map 2:a -map 3:s -map_metadata 4 -map_chapters 4 \
    -c:v libx264 -preset veryfast -crf 40 -g 20 -pix_fmt yuv420p -c:a aac -b:a 24k -ac 1 -c:s srt \
    -metadata:s:a:0 language=eng -metadata:s:a:0 title="English 2.0" -metadata:s:a:1 language=eng -metadata:s:a:1 title="Director commentary" \
    -metadata:s:s:0 language=eng "media/hl_e01_multi.mkv"
# 10-bit H.264 (High10): decodes cleanly in software, not on typical hardware/browser clients
meta_ep t_e06.txt "Gull Rock" "Harbor Lights" 1 6 2000 6000
$FF -f lavfi -i "testsrc2=size=256x192:rate=10:duration=6,$(card3 'HARBOR LIGHTS' 'S01E06' 'GULL ROCK' 'lt(t,2)')" -f lavfi -i "sine=frequency=310:sample_rate=22050:duration=6" \
    -f ffmetadata -i t_e06.txt -map 0:v -map 1:a -map_metadata 2 -map_chapters 2 \
    -c:v libx264 -preset veryfast -crf 40 -g 20 -profile:v high10 -pix_fmt yuv420p10le -c:a aac -b:a 24k -ac 1 media/hl_e06_hi10.mkv

# corrupt variants of hl_e02_good.mkv
sz=$(wc -c < media/hl_e02_good.mkv)
head -c $((sz*55/100)) media/hl_e02_good.mkv > media/hl_e02_trunc.mkv
cp media/hl_e02_good.mkv media/hl_e02_flip.mkv
off=$((sz*55/100)); head -c 2048 /dev/zero | tr '\0' '\377' | dd of=media/hl_e02_flip.mkv bs=1 seek=$off conv=notrunc 2>/dev/null
cp media/hl_e02_good.mkv media/hl_e02_flip2.mkv
off=$((sz*70/100)); head -c 2048 /dev/zero | tr '\0' '\252' | dd of=media/hl_e02_flip2.mkv bs=1 seek=$off conv=notrunc 2>/dev/null

echo STEP movies >&2
# ---- Movies (fictional "Quiet Orbit" 2019; theatrical cut 8 s, extended cut 12 s; "Paper Kingdom" 2017)
meta_plain m_qo.txt "Quiet Orbit"
vid qo_main.mkv 8 200 "$(card 'QUIET ORBIT' 'lt(t,2)' 100)" m_qo.txt
vid qo_ext.mkv 12 200 "$(card 'QUIET ORBIT' 'lt(t,2)' 90),$(card 'EXTENDED CUT' 'lt(t,2)' 130)" m_qo.txt
vid qo_double.mkv 16 200 "$(card 'QUIET ORBIT' 'lt(t,2)' 100)" m_qo.txt
meta_plain m_pk.txt "Paper Kingdom"
vid po_paper.mkv 11 240 "$(card 'PAPER KINGDOM' 'lt(t,2)' 100)" m_pk.txt
# HEVC Main10 + 5.1 AC-3 (client cannot direct-play), clean decode
$FF -f lavfi -i "testsrc2=size=256x192:rate=10:duration=6,$(card 'QUIET ORBIT' 'lt(t,2)' 100)" -f lavfi -i "sine=frequency=200:sample_rate=48000:duration=6" \
    -map 0:v -map 1:a -c:v libx265 -preset ultrafast -crf 40 -x265-params "pools=1:frame-threads=1:log-level=none" -pix_fmt yuv420p10le \
    -c:a ac3 -b:a 96k -ac 6 -metadata:s:a:0 language=eng media/qo_hevc.mkv
# conversions of qo_hevc.mkv: a good one (H.264 8-bit + AAC stereo) and a failed one that lost its audio
$FF -i media/qo_hevc.mkv -map 0:v -map 0:a -c:v libx264 -preset veryfast -crf 40 -pix_fmt yuv420p -c:a aac -b:a 24k -ac 2 -movflags +faststart media/qo_conv_ok.mp4
$FF -i media/qo_hevc.mkv -map 0:v -c:v libx264 -preset veryfast -crf 40 -pix_fmt yuv420p -an -movflags +faststart media/qo_conv_noaudio.mp4
# mp4 with moov at the end, cut at 70 percent (moov atom lost)
$FF -i media/qo_main.mkv -c copy -f mp4 media/qo_full.mp4
szm=$(wc -c < media/qo_full.mp4); head -c $((szm*70/100)) media/qo_full.mp4 > media/qo_nomoov.mp4; rm media/qo_full.mp4
: > media/qo_zero.mkv

echo STEP audiobook >&2
# ---- Audiobook (fictional "The Lantern Road", Ellis Marr, 20 s; chapters at 0/5/10/15)
chap() { # file step_ms title1.. : one chapter per title, each step_ms long
  f=$1; step=$2; shift 2; { echo ";FFMETADATA1"; i=0; for t in "$@"; do
      echo "[CHAPTER]"; echo "TIMEBASE=1/1000"; echo "START=$((i*step))"; echo "END=$(((i+1)*step))"; echo "title=$t"; i=$((i+1)); done; } > "$f"; }
tags_lr() { printf 'title=The Lantern Road\nartist=Mira Tolland\nalbum=The Lantern Road\ncomposer=Ellis Marr\ndate=2019\ngenre=Audiobook\n' ; }
{ echo ";FFMETADATA1"; tags_lr; } > a_lr.txt
chap a_lr_ch.txt 5000 "Opening Credits" "Chapter 1 Rain" "Chapter 2 Salt" "Chapter 3 Lanterns"
cat a_lr.txt > a_lr_full.txt; sed 1d a_lr_ch.txt >> a_lr_full.txt
abook() { out=$1; meta=$2; dur=$3; shift 3; $FF -f lavfi -i "sine=frequency=180:sample_rate=22050:duration=$dur" -f ffmetadata -i "$meta" -map 0:a -map_metadata 1 -map_chapters 1 "$@" "media/$out"; }
abook lr.m4b a_lr_full.txt 20 -c:a aac -b:a 24k -ac 1 -f ipod
abook lr.mp3 a_lr_full.txt 20 -c:a libmp3lame -b:a 32k -ac 1 -id3v2_version 3
szb=$(wc -c < media/lr.m4b); head -c $((szb*50/100)) media/lr.m4b > media/lr_trunc.m4b
$FF -f lavfi -i "sine=frequency=180:sample_rate=22050:duration=1" -f ffmetadata -i a_lr_full.txt -map 0:a -map_metadata 1 -map_chapters 1 -t 0 -c:a libmp3lame -b:a 32k -ac 1 -id3v2_version 3 media/lr_empty.mp3 || echo "lr_empty: ffmpeg rc=$?" >&2
{ echo ";FFMETADATA1"; printf 'title=The Lantern Road\nartist=Ellis Marr\nalbum=The Lantern Road\ndate=2016\n'; } > a_wrong.txt
chap a_wrong_ch.txt 3000 "Prologue" "Chapter 1 Ashes" "Chapter 2 Embers" "Chapter 3 Ash Fall"; sed 1d a_wrong_ch.txt >> a_wrong.txt
abook lr_wrong.m4b a_wrong.txt 12 -c:a aac -b:a 24k -ac 1 -f ipod
{ echo ";FFMETADATA1"; printf 'album=\nartist=\n'; } > a_untitled.txt; sed 1d a_lr_ch.txt >> a_untitled.txt
abook lr_untitled.m4b a_untitled.txt 20 -c:a aac -b:a 24k -ac 1 -f ipod
echo ";FFMETADATA1" > a_blank.txt
abook lr_blank.m4b a_blank.txt 20 -c:a aac -b:a 24k -ac 1 -f ipod

echo STEP probes >&2; du -sk media >&2
# ---- probes, bounded decode windows, full decode, hashes
for f in media/*; do
  n=$(basename "$f")
  nice -n 19 ffprobe -v error -show_format -show_streams -show_chapters -of json "$f" > "probes/$n.probe.json" 2> "probes/$n.probe.err"; echo $? > "probes/$n.probe.rc"
  for s in 0 4 8 12; do
    nice -n 19 ffmpeg -nostdin -v error -threads 1 -ss $s -t 4 -i "$f" -map 0:v:0? -map 0:a:0? -sn -dn -f null - -progress pipe:1 -nostats > "decode/$n.ss$s.prog" 2> "decode/$n.ss$s.err"; echo $? > "decode/$n.ss$s.rc"
  done
  nice -n 19 ffmpeg -nostdin -v error -threads 1 -i "$f" -map 0:v:0? -map 0:a:0? -sn -dn -f null - -progress pipe:1 -nostats > "decode/$n.full.prog" 2> "decode/$n.full.err"; echo $? > "decode/$n.full.rc"
done
rm -rf tmp *.txt *.srt
( cd media && sha256sum * ) > SHA256SUMS
ffmpeg -version | head -1 > TOOL_VERSION
ls -l media
