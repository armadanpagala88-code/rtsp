const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

// YOLO Python script path
const YOLO_SCRIPT = path.join(__dirname, 'yolo_detection.py');
let pythonAvailable = false;

// Check if Python and YOLO are available
async function checkPythonYOLO() {
  return new Promise((resolve) => {
    const python = spawn('python3', ['-c', 'import ultralytics; print("OK")']);
    python.on('close', (code) => {
      pythonAvailable = code === 0;
      if (pythonAvailable) {
        console.log('Python and YOLO are available');
      } else {
        console.warn('Python or YOLO not available. Install with: pip install -r requirements.txt');
      }
      resolve(pythonAvailable);
    });
    python.on('error', () => {
      pythonAvailable = false;
      resolve(false);
    });
  });
}

// Initialize detection model
async function initDetectionModel() {
  try {
    console.log('Checking YOLO availability...');
    await checkPythonYOLO();

    if (!pythonAvailable) {
      throw new Error('Python or YOLO not available. Please install: pip install -r requirements.txt');
    }

    // Check if script exists
    if (!fs.existsSync(YOLO_SCRIPT)) {
      throw new Error('YOLO detection script not found');
    }

    console.log('YOLO detection ready');
    return true;
  } catch (error) {
    console.error('Error initializing YOLO detection:', error);
    throw error;
  }
}

// Detect objects using YOLO via Python
async function detectObjects(imageBuffer, roi = null) {
  if (!pythonAvailable) {
    await initDetectionModel();
  }

  if (!pythonAvailable) {
    throw new Error('YOLO detection not available');
  }

  try {
    // Convert buffer to base64
    const base64Image = imageBuffer.toString('base64');

    // Prepare ROI data if provided
    const roiData = roi ? JSON.stringify(roi) : 'null';

    // Call Python YOLO script with ROI
    return new Promise((resolve, reject) => {
      const python = spawn('python3', [YOLO_SCRIPT, base64Image, roiData]);

      let stdout = '';
      let stderr = '';

      python.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      python.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      python.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(`YOLO detection failed: ${stderr}`));
          return;
        }

        try {
          const result = JSON.parse(stdout);

          if (!result.success) {
            reject(new Error(result.error || 'Detection failed'));
            return;
          }

          // Format results to match expected structure
          const detections = result.detections.map(d => ({
            class: d.class,
            score: d.score,
            bbox: d.bbox
          }));

          resolve(detections);
        } catch (error) {
          reject(new Error(`Failed to parse YOLO output: ${error.message}`));
        }
      });

      python.on('error', (error) => {
        reject(new Error(`Failed to spawn Python process: ${error.message}`));
      });
    });
  } catch (error) {
    console.error('Error detecting objects with YOLO:', error);
    throw error;
  }
}

// Detect objects from base64 image
async function detectFromBase64(base64Image, roi = null) {
  try {
    // Remove data URL prefix if present
    const base64Data = base64Image.replace(/^data:image\/\w+;base64,/, '');
    const imageBuffer = Buffer.from(base64Data, 'base64');

    return await detectObjects(imageBuffer, roi);
  } catch (error) {
    console.error('Error detecting from base64:', error);
    throw error;
  }
}

// Process frame from RTSP stream
async function processFrame(frameBuffer) {
  try {
    const detections = await detectObjects(frameBuffer);

    // Draw bounding boxes on image
    const annotatedImage = await drawBoundingBoxes(frameBuffer, detections);

    return {
      detections,
      annotatedImage
    };
  } catch (error) {
    console.error('Error processing frame:', error);
    throw error;
  }
}

// Draw bounding boxes on image (not needed - frontend will handle it)
async function drawBoundingBoxes(imageBuffer, detections) {
  // Frontend will draw bounding boxes using canvas
  return imageBuffer;
}

// Check if container is overloaded
function isOverloaded(detections) {
  // Check for 'Container' (legacy) or 'Bak Sampah' (new)
  const containerCount = detections.filter(d => d.class === 'Container' || d.class === 'Bak Sampah').length;
  const overloadCount = detections.filter(d => d.class === 'Sampah_Overload').length;

  // Heuristic: if multiple containers detected or overload detected
  return containerCount > 2 || overloadCount > 0;
}

module.exports = {
  initDetectionModel,
  detectObjects,
  detectFromBase64,
  processFrame,
  isOverloaded
};

