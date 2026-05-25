CREATE DATABASE IF NOT EXISTS sekolah_db;
USE sekolah_db;

CREATE TABLE users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  username VARCHAR(50) UNIQUE NOT NULL,
  password VARCHAR(255) NOT NULL,
  nama VARCHAR(100) NOT NULL,
  nama_siswa VARCHAR(100) NOT NULL,
  kelas VARCHAR(20) NOT NULL
);

CREATE TABLE tagihan (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  jenis VARCHAR(100) NOT NULL,
  jumlah BIGINT NOT NULL,
  tanggal_bayar DATE,
  status ENUM('lunas','belum') DEFAULT 'belum',
  FOREIGN KEY (user_id) REFERENCES users(id)
);