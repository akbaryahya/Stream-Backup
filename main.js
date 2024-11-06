const minimist = require('minimist');
const ffmpeg = require('fluent-ffmpeg');

// Parse command line arguments
const args = minimist(process.argv.slice(2));

// Set environment variables based on command-line arguments
const RTSP_STREAM_URL = args.RTSP_STREAM_URL || 'rtsp://0.0.0.0/user=xxx_password=xxx_channel=0_stream=0&onvif=1.sdp?real_stream';
const BACKUP_VIDEO_FILE = args.BACKUP_VIDEO_FILE || 'offline.mp4';
const STREAM_URL = args.STREAM_URL || 'rtmp://a.rtmp.youtube.com/live2/xxxx';

const RESOLUTION = args.RESOLUTION || '1280:720';

console.log(`URL RTSP: ${RTSP_STREAM_URL}`)
console.log(`URL STREAM: ${STREAM_URL}`)

let lastFrameTime = Date.now();
let lastStreamTime = null;  // Last reported time from FFmpeg
let stuckThreshold = 5; // Time threshold for stuck stream.
let nextCheck = 3; // Time threshold for wait next check stream.
let isStreamStuck = false;  // Flag to track stuck state
let currentSource = null;
let checkMainStreamInterval = null; // Interval to check if RTSP is back
//let checkStreamInterval = null;
let stderrLine = ""
let currentFF = null;
let ffCheck = null;

// Function to start the stream
function startStream(source, loop = false) {

    if (currentFF) currentFF.kill(`SIGINT`)
    currentFF = ffmpeg(source)
        .videoCodec('libx264')
        .outputOptions([
            '-preset veryfast', // Use faster preset
            '-c:a aac', // Audio codec for YouTube
            '-ar 44100',// Set audio sample rate
            '-b:a 128k',// Set audio bitrate
            '-f flv', // Output format for YouTube
            '-fflags', 'nobuffer', // Reduce latency
            '-rtsp_transport', 'tcp', // Use TCP for RTSP
            //'-rtbufsize', '10M', // Larger buffer for RTSP
            '-rw_timeout', '2000000',
            //'-stimeout', '2000000',
            //'-timeout', '2',
            '-r', '10', // Frame rate to 10 FPS for stability
        ])
        .videoFilter('scale='+RESOLUTION)
        .output(STREAM_URL)
        .on('start', (commandLine) => {
            console.log(`Streaming main started with source: ${source} > ${commandLine}`);
            currentSource = source;
        })
        .on('stderr', (i) => {
            //console.error(`FFmpeg stderr: ${i}`);
            stderrLine = i
        })
        .on('error', (i) => {
            console.error(`Stream main error with source ${currentSource}: ${i.message}`);
            stderrLine = i.message
        })
        .on('end', () => {
            console.log(`Stream main ended for source: ${currentSource}`);
            stderrLine = `end`
        });

    // Loop video
    if (loop) {
        currentFF.inputOptions(['-stream_loop -1']);
    }

    currentFF.run();
}

// Function to monitor the stream and detect if it's stuck
function checkIfStreamIsStuck() {
    // Parse the time data from stderr output
    let weNeedCheck = false
    const timeMatch = stderrLine.match(/time=\s*([\d:.]+)/);
    if (timeMatch) {
        const currentTime = timeMatch[1];
        const currentMillis = timeToMillis(currentTime);
        if (lastStreamTime && currentMillis === lastStreamTime) {
            // If the time hasn't changed, it's stuck
            console.log(`Stream appears to be stuck at time: ${currentTime}`);
            if (!isStreamStuck && Date.now() - lastFrameTime > (1000 * stuckThreshold)) {
                // If the stream has been stuck for more than the threshold, switch to backup
                console.log('Stream is stuck for too long. Switching to backup.');
                isStreamStuck = true;
                startStream(BACKUP_VIDEO_FILE, true);
            }
        } else {
            // If time is progressing, update last time
            lastStreamTime = currentMillis;
            lastFrameTime = Date.now();
            if (currentSource == RTSP_STREAM_URL) {
                console.log("LIVE: " + stderrLine)
                //if (ffCheck) ffCheck.kill('SIGINT');
                isStreamStuck = false;
            } else {
                console.error("OFFLINE: " + stderrLine)
                weNeedCheck = true
            }
        }
    } else {
        console.error(`NoTime:${currentSource}` + stderrLine)
        //weNeedCheck = true
    }

    if (weNeedCheck) {
        //console.log(`stream stuck......`)
        checkMainStream();
    }
}

// Function to check if RTSP stream is live again
function checkMainStream() {
    if (!checkMainStreamInterval) {
        // Try to restart RTSP stream
        checkMainStreamInterval = setTimeout(() => {
            console.log('Checking if RTSP stream is live...');

            if (ffCheck) ffCheck.kill('SIGINT');
            ffCheck = ffmpeg(RTSP_STREAM_URL)
                .videoCodec('libx264')
                .outputOptions([
                    '-preset veryfast', // Use faster preset
                    '-c:a aac', // Audio codec for YouTube
                    '-ar 44100',// Set audio sample rate
                    '-b:a 128k',// Set audio bitrate
                    '-f flv', // Output format for YouTube
                    '-rtsp_transport', 'tcp', // Use TCP for RTSP
                    '-rw_timeout', '2000000',
                    //'-stimeout', '2000000',
                    //'-timeout', '2',
                    '-r', '1', // Frame rate to 10 FPS for stability
                ])
                .inputOptions('-t 1') // Short stream
                .videoFilter('scale='+RESOLUTION)
                .output(STREAM_URL)
                .on('start', () => {
                    console.log('RTSP backup check live....');
                })
                .on('stderr', (i) => {
                    console.log(`FFmpeg backup stderr: ${i}`);
                    const timeMatch = i.match(/time=\s*([\d:.]+)/); //i.includes(`Input #0`)
                    if (timeMatch) {
                        // kill it
                        if (ffCheck) ffCheck.kill('SIGINT');
                        // RTSP is live, switch back from backup                        
                        isStreamStuck = false;
                        // start back
                        startStream(RTSP_STREAM_URL);
                        console.log('RTSP main back live....');
                    }

                    // Timeout wait load
                    //if(checkStreamInterval) clearInterval(checkStreamInterval)
                    //checkStreamInterval = setTimeout(() => {
                    //clearInterval(checkMainStreamInterval);
                    //checkMainStreamInterval = null;
                    //}, 1000 * 2);

                })
                .on('error', (i) => {
                    console.error(`Stream backup error: ${i.message}`);

                    clearInterval(checkMainStreamInterval);
                    checkMainStreamInterval = null;

                    if (!(i.message).includes(`killed`)) {
                        console.log(`RTSP stream ${RTSP_STREAM_URL} not available yet: `, i);
                        isStreamStuck = true;
                    }

                })
                .on('end', () => {
                    console.log(`Streaming backup ended`);

                    clearInterval(checkMainStreamInterval);
                    checkMainStreamInterval = null;
                })
                .run();

        }, 1000 * nextCheck);
    }
}

// Helper function to convert FFmpeg time format to milliseconds
function timeToMillis(timeString) {
    const timeParts = timeString.split(':');
    let millis = 0;
    if (timeParts.length === 3) {
        millis += parseInt(timeParts[0]) * 3600000; // hours to ms
        millis += parseInt(timeParts[1]) * 60000;   // minutes to ms
        millis += parseFloat(timeParts[2]) * 1000;  // seconds to ms
    } else if (timeParts.length === 2) {
        millis += parseInt(timeParts[0]) * 60000;   // minutes to ms
        millis += parseFloat(timeParts[1]) * 1000;  // seconds to ms
    }
    return millis;
}

// Start stream with RTSP source
startStream(RTSP_STREAM_URL);

// Loop check
setInterval(() => {
    checkIfStreamIsStuck()
}, 1000);