#!/bin/bash
# frames/ の連番 + title.png + caption.png を 1本の mp4 に組み立てる。
set -e
cd "$(dirname "$0")/frames"
FPS=24
NF=$(ls f????.png | wc -l | tr -d ' '); DUR=$(python3 -c "print($NF/$FPS)")
ffmpeg -y -loglevel error \
  -loop 1 -t 1.6 -i title.png \
  -framerate $FPS -i f%04d.png \
  -loop 1 -t "$DUR" -framerate $FPS -i caption.png \
  -filter_complex "\
   [0:v]scale=1280:720,fps=$FPS,setsar=1,format=yuv420p,fade=t=in:st=0:d=0.4,fade=t=out:st=1.25:d=0.35[t]; \
   [2:v]format=rgba,fade=t=in:st=4.3:d=0.5:alpha=1,fade=t=out:st=6.3:d=0.5:alpha=1[cap]; \
   [1:v]setsar=1[m0];[m0][cap]overlay=0:0:eof_action=pass,format=yuv420p[main]; \
   [t][main]concat=n=2:v=1:a=0[out]" \
  -map "[out]" -c:v libx264 -crf 28 -preset veryfast -movflags +faststart ../trojan_journey.mp4
echo "-> tools/cine/trojan_journey.mp4  ($NF frames, ${DUR}s main)"
ffprobe -v error -show_entries format=duration,size:stream=width,height,nb_frames -of default=noprint_wrappers=1 ../trojan_journey.mp4
