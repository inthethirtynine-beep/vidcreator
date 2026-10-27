const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const DEFAULT_API_KEY = process.env.VIDKRAKEN_API_KEY || '507f2f9f-8cc1-491d-9a46-65dbff0af0b7';
const API_BASE = 'https://vidkraken.com/api/v2';

/**
 * Start YouTube download job via VidKraken API
 */
function startYouTubeJob(youtubeUrl, format = '1080', apiKey = DEFAULT_API_KEY) {
  return new Promise((resolve, reject) => {
    const key = apiKey || DEFAULT_API_KEY;
    const postData = JSON.stringify({
      url: youtubeUrl,
      format: String(format || '1080'),
    });

    const req = https.request(`${API_BASE}/download`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${key}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData),
      },
    }, (res) => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        try {
          const data = JSON.parse(body);
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(data);
          } else {
            reject(new Error(data.message || data.error || `VidKraken API error (${res.statusCode})`));
          }
        } catch (e) {
          reject(new Error(`Failed to parse VidKraken response: ${body.slice(0, 100)}`));
        }
      });
    });

    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

/**
 * Check status of a VidKraken download job
 */
function getJobStatus(jobId, apiKey = DEFAULT_API_KEY) {
  return new Promise((resolve, reject) => {
    const key = apiKey || DEFAULT_API_KEY;

    const req = https.request(`${API_BASE}/download/${jobId}`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${key}`,
      },
    }, (res) => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        try {
          const data = JSON.parse(body);
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(data);
          } else {
            reject(new Error(data.message || data.error || `VidKraken status error (${res.statusCode})`));
          }
        } catch (e) {
          reject(new Error(`Failed to parse status response: ${body.slice(0, 100)}`));
        }
      });
    });

    req.on('error', reject);
    req.end();
  });
}

/**
 * Download a remote video file (handles redirects) to target local path
 */
function downloadFile(fileUrl, destPath, onProgress) {
  return new Promise((resolve, reject) => {
    function get(currentUrl, redirectCount = 0) {
      if (redirectCount > 5) {
        return reject(new Error('Too many redirects while downloading file'));
      }

      const parsedUrl = new URL(currentUrl);
      const client = parsedUrl.protocol === 'https:' ? https : http;

      client.get(currentUrl, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          const redirectUrl = new URL(res.headers.location, currentUrl).href;
          return get(redirectUrl, redirectCount + 1);
        }

        if (res.statusCode !== 200) {
          return reject(new Error(`Download failed with status ${res.statusCode}`));
        }

        const totalBytes = parseInt(res.headers['content-length'], 10) || 0;
        let downloadedBytes = 0;

        const fileStream = fs.createWriteStream(destPath);

        res.on('data', (chunk) => {
          downloadedBytes += chunk.length;
          if (onProgress && totalBytes > 0) {
            const percent = Math.min(100, Math.round((downloadedBytes / totalBytes) * 100));
            onProgress({ downloadedBytes, totalBytes, percent });
          }
        });

        res.pipe(fileStream);

        fileStream.on('finish', () => {
          fileStream.close(() => resolve(destPath));
        });

        fileStream.on('error', (err) => {
          fs.unlink(destPath, () => {});
          reject(err);
        });
      }).on('error', (err) => {
        fs.unlink(destPath, () => {});
        reject(err);
      });
    }

    get(fileUrl);
  });
}

module.exports = {
  DEFAULT_API_KEY,
  startYouTubeJob,
  getJobStatus,
  downloadFile,
};
