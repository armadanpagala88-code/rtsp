# YOLO Detection Setup (Latest Version)

## Versi Terbaru
- **Ultralytics**: >= 8.3.0 (Latest YOLOv8/YOLOv11)
- **PyTorch**: >= 2.4.0
- **Model**: YOLOv8n (nano) - fastest, atau YOLOv8s/m untuk akurasi lebih baik

## Instalasi

1. **Install Python dependencies:**
   ```bash
   ./install_yolo.sh
   ```
   
   Atau manual:
   ```bash
   pip3 install --upgrade -r requirements.txt
   ```

2. **YOLOv8 model akan di-download otomatis** saat pertama kali digunakan
   - YOLOv8n.pt: ~6MB (fastest, recommended)
   - YOLOv8s.pt: ~22MB (balanced)
   - YOLOv8m.pt: ~52MB (more accurate)

## Cara Kerja

- YOLO detection berjalan via Python script (`yolo_detection.py`)
- Node.js berkomunikasi dengan Python via child_process
- Detection berjalan setiap 30 frame (sekitar 2 detik)
- Hasil detection dikirim ke frontend via WebSocket
- Menggunakan API terbaru dari Ultralytics

## Fitur Terbaru

- ✅ Support YOLOv8 latest version
- ✅ Improved class mapping untuk bak sampah
- ✅ Better detection accuracy
- ✅ Optimized performance
- ✅ Support GPU acceleration (jika tersedia)

## Custom Model (Opsional)

Untuk akurasi lebih baik, Anda bisa train custom YOLO model:

1. Siapkan dataset gambar bak sampah dengan anotasi YOLO format
2. Train dengan YOLOv8 terbaru:
   ```bash
   yolo train data=your_dataset.yaml model=yolov8n.pt epochs=100 imgsz=640
   ```
3. Simpan model di `models/trash_detection.pt`
4. Script akan otomatis menggunakan custom model jika ada

## Troubleshooting

- **Python tidak ditemukan**: Install Python 3.8+
- **Module not found**: Jalankan `pip3 install --upgrade -r requirements.txt`
- **Detection lambat**: 
  - Gunakan YOLOv8n (nano) untuk kecepatan
  - Atau YOLOv8s untuk akurasi lebih baik
  - Enable GPU jika tersedia (ubah device='cpu' ke device='cuda' di yolo_detection.py)
- **Model download gagal**: Periksa koneksi internet, model akan di-download dari ultralytics

