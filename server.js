const express = require('express');
const fs = require('fs');
const fsp = fs.promises; // 用于需要 Promise 的场景
const path = require('path');
const AdmZip = require('adm-zip');
const { v4: uuidv4 } = require('uuid');

const app = express();
// 在server.js中添加
const cors = require('cors');
app.use(cors()); // 允许所有跨域请求（开发环境用）
app.use(express.static('public')); // 新增这行

app.use(express.json()); // 只处理 JSON 请求体
app.use(express.urlencoded({ extended: true }));

// 设置 Express 静态资源服务，映射 "/covers" 路径到 "public/covers" 目录
// 这样，客户端可以通过 "/covers/文件名" 直接访问存储在 "public/covers" 目录下的封面图片
app.use('/covers', express.static(path.join(__dirname, 'public', 'covers')));

const COMICS_DIR = path.join(__dirname, 'comics');
const DB_FILE = path.join(__dirname, 'comics.json');

// 支持的图片格式
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp']);

// 初始化漫画数据库
let comicsDB = [];

// 启动时加载数据库并扫描目录
async function initialize() {
  try {
    const data = await fsp.readFile(DB_FILE);
    comicsDB = JSON.parse(data);
  } catch (err) {
    if (err.code === 'ENOENT') {
      await fsp.writeFile(DB_FILE, '[]');
    }
  }

  await scanComicsDirectory();
}

// 扫描漫画目录
async function scanComicsDirectory() {
  const files = await fsp.readdir(COMICS_DIR);
  const zipFiles = files.filter(file => path.extname(file).toLowerCase() === '.zip');

  for (const file of zipFiles) {
    const existing = comicsDB.find(c => c.fileName === file);
    if (!existing) {
      await processNewComic(file);
    }
  }
}

// 处理新漫画
async function processNewComic(fileName) {
  const filePath = path.join(COMICS_DIR, fileName);
  const zip = new AdmZip(filePath);
  const zipEntries = zip.getEntries();

  // 查找第一个图片文件
  const images = zipEntries
    .filter(entry => !entry.isDirectory)
    .filter(entry => IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))
    .sort((a, b) => a.name.localeCompare(b.name));

  if (images.length === 0) return;

  // 读取封面图片
  const coverImage = images[0];
  const coverData = zip.readFile(coverImage);

  // 创建漫画记录
  const comicRecord = {
    id: uuidv4(),
    fileName: fileName,
    filePath: filePath,
    title: path.parse(fileName).name,
    cover: '',
    pageCount: images.length,
    addedAt: new Date().toISOString(),
    tags: []
  };

  const coverFileName = `${comicRecord.id}.jpg`;
  const coverPath = path.join(__dirname, 'public', 'covers', coverFileName);
  await fsp.writeFile(coverPath, coverData);
  comicRecord.cover = `/covers/${coverFileName}`

  comicsDB.push(comicRecord);
  await fsp.writeFile(DB_FILE, JSON.stringify(comicsDB, null, 2));
}

// 通过 ID 获取漫画的流式传输
app.get('/api/comic/:id/page/:pageNumber', async (req, res) => {
  console.log('[1] 收到请求参数:', req.params);
  
  try {
    const { id, pageNumber } = req.params;
    const pageIndex = parseInt(pageNumber, 10);
    
    // 查找漫画记录
    const comic = comicsDB.find(c => c.id === id);
    console.log('[2] 找到的漫画记录:', comic ? comic.id : '未找到');
    if (!comic) return res.status(404).send('Comic not found');

    // 验证文件存在性
    console.log('[3] 尝试访问文件:', comic.filePath);
    if (!fs.existsSync(comic.filePath)) {
      console.error('[ERROR] 文件不存在:', comic.filePath);
      return res.status(404).send('File not found');
    }

    // 读取ZIP文件
    const zip = new AdmZip(comic.filePath);
    const zipEntries = zip.getEntries();
    console.log('[4] ZIP文件条目数量:', zipEntries.length);

    // 过滤并排序图片
    const images = zipEntries
      .filter(entry => !entry.isDirectory)
      .filter(entry => IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))
      .sort((a, b) => a.name.localeCompare(b.name));
    
    console.log('[5] 有效图片数量:', images.length);
    console.log('[6] 请求页码:', pageIndex);

    if (pageIndex < 0 || pageIndex >= images.length) {
      console.error('[ERROR] 无效页码:', pageIndex);
      return res.status(400).send('Invalid page number');
    }

    // 获取目标图片
    const image = images[pageIndex];
    console.log('[7] 目标图片信息:', {
      name: image.name,
      size: image.header.size,
      compressedSize: image.header.compressedSize
    });

    // 读取图片数据
    const imageData = zip.readFile(image);
    console.log('[8] 读取的图片数据长度:', imageData.length);

    // 动态设置Content-Type
    const ext = path.extname(image.name).toLowerCase();
    const mimeType = {
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.gif': 'image/gif',
      '.webp': 'image/webp'
    }[ext] || 'application/octet-stream';
    
    console.log('[9] 设置的Content-Type:', mimeType);
    
    // 发送响应
    res.setHeader('Content-Type', mimeType);
    res.send(imageData); // 注意这里不再使用 Buffer.from

  } catch (error) {
    console.error('[FATAL ERROR] 服务端异常:', error);
    res.status(500).send('Internal Server Error');
  }
});


// Express路由
app.get('/api/comics', async (req, res) => {
  await scanComicsDirectory(); // 每次请求时检查更新（生产环境建议用文件监视）
  res.json(comicsDB);
});

// 启动服务器
initialize().then(() => {
  app.listen(5239, () => {
    console.log('Server running on http://localhost:5239');
  });
});