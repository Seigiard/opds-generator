# OPDS Generator

Генератор статического OPDS каталога из файловой структуры.

**Философия**: примитивные функции, 0 зависимостей, максимальная простота.

## Текущий статус

### Реализовано
- [x] Сканирование директории с книгами
- [x] Stat-based хэширование (path + size + mtime, без чтения содержимого)
- [x] Генерация OPDS Navigation + Acquisition feeds
- [x] Имя файла (без расширения) → title
- [x] HTTP сервер (Bun.serve + Bun.file)
- [x] Кэширование фидов в $DATA/opds/
- [x] Автоматический ребилд при изменении файлов
- [x] Dockerfile + docker-compose

### Планируется
- [ ] ETag + 304 Not Modified
- [ ] fs.watch для hot reload
- [ ] Извлечение метаданных из EPUB (обложки, автор, описание)

## Архитектура

### Входные параметры (env)
```
FILES=/path/to/books    # Директория с файлами
DATA=/path/to/cache     # Кэш и метаданные
PORT=8080               # HTTP порт
BASE_URL=http://...     # Базовый URL для ссылок
```

### Структура $DATA
```
$DATA/
├── manifest.json       # Хэш каталога + индекс файлов
└── opds/               # Сгенерированные OPDS фиды
    ├── root.xml        # GET /opds
    ├── fiction.xml     # GET /opds/fiction
    └── fiction--scifi.xml  # GET /opds/fiction/scifi
```

### Структура проекта
```
src/
├── index.ts      # Entry point: Bun.serve()
├── scanner.ts    # scanDirectory, computeHash
├── manifest.ts   # readManifest, writeManifest
├── metadata.ts   # extractBasicMeta
├── opds.ts       # buildFeed, escapeXml
└── types.ts      # FileInfo, BookMeta, Manifest
```

## API

| Endpoint | Описание |
|----------|----------|
| `GET /opds` | Корневой каталог (Navigation Feed) |
| `GET /opds/{path}` | Подкаталог или список книг |
| `GET /download/{path}` | Скачивание файла |

## Запуск

```bash
# Разработка
bun run dev

# Продакшен
FILES=/books DATA=/data PORT=8080 bun run start

# Docker
docker-compose up
```

## Поддерживаемые форматы
epub, pdf, mobi, azw3, fb2, cbz, cbr, djvu, txt

## OPDS Specification
https://specs.opds.io/opds-1.2
