const minimist = require("minimist")
const ffmpeg = require("fluent-ffmpeg")
const fs = require("fs")

const args = minimist(process.argv.slice(2))

class StreamMonitor {
	constructor({
		nameStream,
		rtspUrl,
		streamUrl,
		backupUrl = "offline.mp4",
		resolution = "1280:720",
		stuckThreshold = 5,
		checkInterval = 3
	}) {
		this.nameStream = nameStream
		this.rtspUrl = rtspUrl
		this.backupUrl = backupUrl
		this.streamUrl = streamUrl
		this.resolution = resolution
		this.stuckThreshold = stuckThreshold
		this.checkInterval = checkInterval

		this.lastFrameTime = Date.now()
		this.lastStreamTime = null
		this.isStreamStuck = false
		this.currentSource = null
		this.checkMainStreamInterval = null
		//this.checkStreamInterval = null
		this.stderrLine = ""
		this.currentFF = null
		this.ffCheck = null

		this.init()
	}

	init() {
		this.startStream(this.rtspUrl)
		this.monitorStream()
	}

	startStream(source, loop = false) {
		if (this.currentFF) this.currentFF.kill("SIGINT")

		const isImage = source.endsWith(".jpg")
		this.currentFF = ffmpeg(source)
			.inputOptions(isImage ? ["-loop 1"] : loop ? ["-stream_loop -1"] : [])
			.videoCodec("libx264")
			.outputOptions([
				"-preset veryfast",
				"-c:a aac",
				"-ar 44100",
				"-b:a 128k",
				"-f flv",
				"-fflags",
				"nobuffer",
				"-rtsp_transport",
				"tcp",
				"-rtbufsize",
				"10M",
				"-rw_timeout",
				"2000000",
				"-r",
				"10"
			])
			.videoFilter("scale=" + this.resolution)
			.outputOptions(isImage ? ["-filter_complex", "anullsrc=r=44100:cl=stereo", "-shortest"] : [])
			.output(this.streamUrl)
			.on("start", (commandLine) => {
				console.log(`Streaming ${this.nameStream} started with source: ${source} > ${commandLine}`)
				this.currentSource = source
			})
			.on("stderr", (i) => {
				this.stderrLine = i
			})
			.on("error", (i) => {
				console.error(`Stream main ${this.nameStream} is error with source ${this.currentSource}: ${i.message}`)
				this.stderrLine = i.message
			})
			.on("end", () => {
				console.log(`Stream main ${this.nameStream} is ended for source ${this.currentSource}`)
				this.stderrLine = "end"
			})

		this.currentFF.run()
	}

	monitorStream() {
		setInterval(() => {
			this.checkIfStreamIsStuck()
		}, 1000)
	}

	checkIfStreamIsStuck() {
		let weNeedCheck = false
		const timeMatch = this.stderrLine.match(/time=\s*([\d:.]+)/)
		if (timeMatch) {
			const currentTime = timeMatch[1]
			const currentMillis = this.timeToMillis(currentTime)
			if (this.lastStreamTime && currentMillis === this.lastStreamTime) {
				if (!this.isStreamStuck && Date.now() - this.lastFrameTime > 1000 * this.stuckThreshold) {
					console.log(`Stream ${this.nameStream} is stuck. Switching to backup.`)
					this.isStreamStuck = true
					this.startStream(this.backupUrl, true)
				}
			} else {
				this.lastStreamTime = currentMillis
				this.lastFrameTime = Date.now()
				if (this.currentSource === this.rtspUrl) {
					console.log(`LIVE ${this.nameStream}: ${this.stderrLine}`)
					this.isStreamStuck = false
				} else {
					console.error(`OFFLINE ${this.nameStream}: ${this.stderrLine}`)
					weNeedCheck = true
				}
			}
		} else {
			console.error(`NoTime${this.nameStream}: ${this.stderrLine}`)
			if (this.stderrLine.includes(`ffmpeg exited`)) {
				weNeedCheck = true
			}
		}

		if (weNeedCheck) {
			this.checkMainStream()
		}
	}

	checkMainStream() {
		if (!this.checkMainStreamInterval) {
			this.checkMainStreamInterval = setTimeout(() => {
				console.log(`Checking if stream ${this.nameStream} is live?`)

				if (this.ffCheck) this.ffCheck.kill("SIGINT")
				this.ffCheck = ffmpeg(this.rtspUrl)
					.videoCodec("libx264")
					.outputOptions([
						"-preset veryfast",
						"-c:a aac",
						"-ar 44100",
						"-b:a 128k",
						"-f flv",
						"-rw_timeout",
						"2000000",
						"-r",
						"1"
					])
					.inputOptions("-t 1")
					.videoFilter("scale=" + this.resolution)
					.output(this.streamUrl)
					.on("start", () => {
						console.log(`Check stream ${this.nameStream} start !`)
					})
					.on("stderr", (i) => {
						console.log(`stderr ${this.nameStream}: ${i}`)
						const timeMatch = i.match(/time=\s*([\d:.]+)/)
						if (timeMatch) {
							if (this.ffCheck) this.ffCheck.kill("SIGINT")
							this.isStreamStuck = false
							this.startStream(this.rtspUrl)
							console.log(`Stream ${this.nameStream} main is back live`)
						}

						// Timeout wait load
						//if(this.checkStreamInterval) clearInterval(this.checkStreamInterval)
						//this.checkStreamInterval = setTimeout(() => {
						//clearInterval(checkMainStreamInterval);
						//checkMainStreamInterval = null;
						//}, 1000 * 2);
					})
					.on("error", (i) => {
						console.error(`Stream backup error: ${i.message}`)
						clearInterval(this.checkMainStreamInterval)
						this.checkMainStreamInterval = null
						if (!i.message.includes("killed")) {
							console.log(`Stream ${this.nameStream} for ${this.rtspUrl} not available yet: `, i)
							this.isStreamStuck = true
						}
					})
					.on("end", () => {
						console.log(`Streaming check for ${this.nameStream} > backup ended`)
						clearInterval(this.checkMainStreamInterval)
						this.checkMainStreamInterval = null
					})
					.run()
			}, 1000 * this.checkInterval)
		}
	}

	timeToMillis(timeString) {
		const timeParts = timeString.split(":")
		let millis = 0
		if (timeParts.length === 3) {
			millis += parseInt(timeParts[0]) * 3600000
			millis += parseInt(timeParts[1]) * 60000
			millis += parseFloat(timeParts[2]) * 1000
		} else if (timeParts.length === 2) {
			millis += parseInt(timeParts[0]) * 60000
			millis += parseFloat(timeParts[1]) * 1000
		}
		return millis
	}
}

// Helper function to parse command-line arguments
function loadStreamsFromArgsOrConfig() {
	const streams = []

	// Parse arguments for streams in the form of STREAM1_nameStream, STREAM1_rtspUrl, STREAM1_streamUrl, etc.
	Object.keys(args).forEach((key) => {
		const match = key.match(/STREAM(\d+)_(.+)/)
		if (match) {
			const [, streamNumber, property] = match
			const index = parseInt(streamNumber) - 1

			if (!streams[index]) streams[index] = {}
			streams[index][property] = args[key]
		}
	})

	// If no valid streams from arguments, load config.json
	if (streams.length === 0 || !streams[0].nameStream) {
		try {
			const config = JSON.parse(fs.readFileSync("config.json"))
			return config.camera
		} catch (err) {
			console.error("Error reading config.json:", err)
			process.exit(1)
		}
	}

	return streams
}

// Load streams and start monitoring
const streams = loadStreamsFromArgsOrConfig()
streams.forEach((stream) => {
	new StreamMonitor(stream)
})
