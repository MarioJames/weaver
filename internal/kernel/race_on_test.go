//go:build race

package kernel

// The race detector slows the code several times over: wall-clock limits are
// only checked without it.
const raceDetector = true
