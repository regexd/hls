const express = require('express');
const { exec, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');
const request = require('request');

const app = express();
const server = http.createServer(app);
const io = require('socket.io')(server);

const port = 3000;

app.set('view engine', 'ejs');
app.use(express.static('public'));

// Proxy video to avoid CORS
app.get('/proxy', (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).send('URL diperlukan');
  req.pipe(request(url)).pipe(res);
});

// Proxy subtitle to avoid CORS
app.get('/proxy-sub', (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).send('URL diperlukan');
  req.pipe(request(url)).pipe(res);
});

// HLS player page
app.get('/hls', (req, res) => {
  const url = req.query.url;
  const sub = req.query.sub;

  if (!url) return res.send('URL .m3u8 tidak ditemukan.');

  res.render('hls', { url, sub });
});

io.on('connection', (socket) => {
  console.log('Client connected');

  socket.on('startDownload', ({ url, sub }) => {
    const timestamp = Date.now();
    const tempMp4 = `temp_${timestamp}.mp4`;
    const finalMp4 = `video_${timestamp}.mp4`;
    const subtitleFilename = `sub_${timestamp}.ass`;

    // Step 1: Download subtitle .vtt dan convert ke .ass dengan styling
    const downloadSubCmd = `
      wget -O temp.vtt "${sub}" &&
      ffmpeg -i temp.vtt "${subtitleFilename}" &&
      rm temp.vtt &&
      sed -i '/Style:/ s/\\(,\\)[0-9]\\{1,\\}\\(,\\)/\\128\\2/' "${subtitleFilename}" &&
      sed -i '/Style:/ s/MarginV=[0-9]*/MarginV=80/' "${subtitleFilename}"
    `;

    exec(downloadSubCmd, (err) => {
      if (err) {
        console.error(err);
        socket.emit('progress', '❌ Gagal download/convert subtitle.');
        return;
      }

      socket.emit('progress', '✅ Subtitle siap dengan posisi & ukuran sesuai player.');

      const subtitlePath = path.join(__dirname, subtitleFilename);

      // Step 2: Download m3u8 menjadi mp4 tanpa encode (cepat)
      const downloadVideoCmd = `ffmpeg -i "${url}" -c copy -bsf:a aac_adtstoasc "${tempMp4}"`;

      socket.emit('progress', '⬇️ Mulai download video (.m3u8 ➔ mp4 tanpa encode) ...');

      exec(downloadVideoCmd, (err) => {
        if (err) {
          console.error(err);
          socket.emit('progress', '❌ Gagal download video .m3u8');
          return;
        }

        socket.emit('progress', '✅ Download video selesai. Mulai encode subtitle...');

        // Step 3: Encode temp mp4 menjadi final mp4 dengan hard subtitle (ultrafast)
const ffmpegCmd = [
  '-i', tempMp4,
  '-vf', `subtitles=${subtitlePath}:force_style='Fontsize=13,MarginV=80'`,
  '-c:a', 'copy',
  '-preset', 'ultrafast',
  '-y', finalMp4
];

        const ffmpeg = spawn('ffmpeg', ffmpegCmd);

        ffmpeg.stderr.on('data', (data) => {
          const message = data.toString();
          console.log(message);
          if (message.includes('time=')) {
            socket.emit('progress', message);
          }
        });

        ffmpeg.on('close', (code) => {
          console.log(`FFmpeg exited with code ${code}`);

          fs.access(finalMp4, fs.constants.F_OK, (err) => {
            if (err) {
              socket.emit('progress', '❌ Terjadi kesalahan saat convert video.');
            } else {
              socket.emit('progress', '✅ Convert selesai. File siap diunduh.');
              socket.emit('downloadReady', { filename: finalMp4 });
            }

            // Bersihkan temp files
            fs.unlink(tempMp4, () => {});
            fs.unlink(subtitleFilename, () => {});
          });
        });
      });
    });
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected');
  });
});

// Download route
app.get('/download-file/:filename', (req, res) => {
  const filename = req.params.filename;
  const filepath = path.join(__dirname, filename);

  res.download(filepath, filename, (err) => {
    if (err) console.error(err);

    // Hapus file setelah diunduh
    fs.unlink(filepath, (err) => {
      if (err) console.error('Gagal menghapus file video:', err);
      else console.log('File video dihapus:', filename);
    });
  });
});

server.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});
