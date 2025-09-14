import './App.css'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Tesseract from 'tesseract.js'
import tesseractWorker from './wasm/worker.min.js?url'

function App() {
  const [file, setFile] = useState<File | null>(null)
  const [imageUrl, setImageUrl] = useState<string | null>(null)
  const [text, setText] = useState<string>('')
  const [progress, setProgress] = useState<number>(0)
  const [status, setStatus] = useState<string>('idle')
  const [lang, setLang] = useState<string>('eng')
  const imgRef = useRef<HTMLImageElement | null>(null)
  const overlayRef = useRef<HTMLDivElement | null>(null)
  const [dragging, setDragging] = useState(false)
  const [startPt, setStartPt] = useState<{ x: number, y: number } | null>(null)
  const [endPt, setEndPt] = useState<{ x: number, y: number } | null>(null)

  // 创建/清理预览 URL
  useEffect(() => {
    if (!file) return
    const url = URL.createObjectURL(file)
    setImageUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [file])

  // 选择图片后自动触发整图识别
  useEffect(() => {
    if (!file) return
    // 小延迟避免与 URL.createObjectURL 同步竞争
    const t = setTimeout(() => { void handleOcr() }, 0)
    return () => clearTimeout(t)
  }, [file])

  const handleFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]
    setText('')
    setProgress(0)
    setStatus('idle')
    if (f) setFile(f)
  }, [])

  const canOcr = useMemo(() => !!file && status !== 'running', [file, status])

  const handleOcr = useCallback(async () => {
    if (!file) return
    setStatus('running')
    setText('')
    setProgress(0)
    try {
      const { data } = await Tesseract.recognize(file, lang, {
        workerPath: tesseractWorker,
        logger: (m) => {
          if (m.status) setStatus(m.status)
          if (m.progress != null) setProgress(Math.round(m.progress * 100))
        },
      })
      setText(data.text || '未识别到文字')
      setStatus('done')
    } catch (err: any) {
      console.error(err)
      setStatus('error')
      setText(`OCR 失败: ${err?.message || String(err)}`)
    }
  }, [file, lang])

  // 仅对选区执行 OCR
  const handleOcrSelection = useCallback(async (rectInNatural: { left: number, top: number, width: number, height: number }) => {
    if (!imageUrl) return
    setStatus('running')
    setText('')
    setProgress(0)
    try {
      // 先将所选区域裁剪到离屏 canvas，再送入 OCR
      const cropped = await (async () => {
        const img = await new Promise<HTMLImageElement>((resolve, reject) => {
          const im = new Image()
          im.crossOrigin = 'anonymous'
          im.onload = () => resolve(im)
          im.onerror = reject
          im.src = imageUrl
        })
        const { left, top, width, height } = rectInNatural
        const canvas = document.createElement('canvas')
        canvas.width = Math.max(1, width)
        canvas.height = Math.max(1, height)
        const ctx = canvas.getContext('2d')!
        ctx.drawImage(
          img,
          left, top, width, height, // 源区域
          0, 0, canvas.width, canvas.height // 目标
        )
        const blob: Blob = await new Promise((resolve) => canvas.toBlob((b) => resolve(b as Blob), 'image/png'))
        return blob
      })()

      const { data } = await Tesseract.recognize(cropped, lang, {
        workerPath: tesseractWorker,
        logger: (m) => {
          if (m.status) setStatus(m.status)
          if (m.progress != null) setProgress(Math.round(m.progress * 100))
        },
      })
      setText(data.text || '未识别到文字')
      setStatus('done')
    } catch (err: any) {
      console.error(err)
      setStatus('error')
      setText(`OCR 失败: ${err?.message || String(err)}`)
    }
  }, [imageUrl, lang])

  // 计算当前选择在 overlay 内的显示坐标（用于渲染）
  const selectionOverlayRect = useMemo(() => {
    if (!overlayRef.current || !startPt || !endPt) return null
    const overlay = overlayRef.current.getBoundingClientRect()
    const x1 = Math.min(startPt.x, endPt.x)
    const y1 = Math.min(startPt.y, endPt.y)
    const x2 = Math.max(startPt.x, endPt.x)
    const y2 = Math.max(startPt.y, endPt.y)
    const left = Math.max(x1, overlay.left)
    const top = Math.max(y1, overlay.top)
    const right = Math.min(x2, overlay.right)
    const bottom = Math.min(y2, overlay.bottom)
    const width = Math.max(0, right - left)
    const height = Math.max(0, bottom - top)
    return {
      left,
      top,
      width,
      height,
      // 转换为 overlay 内部定位
      relLeft: left - overlay.left,
      relTop: top - overlay.top,
    }
  }, [startPt, endPt])

  // 将选择映射到图片的自然尺寸坐标
  const computeNaturalRectFromSelection = useCallback(() => {
    if (!selectionOverlayRect || !imgRef.current) return null
    const img = imgRef.current
    const imgRect = img.getBoundingClientRect()

    // 与图片显示区域求交集
    const left = Math.max(selectionOverlayRect.left, imgRect.left)
    const top = Math.max(selectionOverlayRect.top, imgRect.top)
    const right = Math.min(selectionOverlayRect.left + selectionOverlayRect.width, imgRect.right)
    const bottom = Math.min(selectionOverlayRect.top + selectionOverlayRect.height, imgRect.bottom)
    const dispWidth = Math.max(0, right - left)
    const dispHeight = Math.max(0, bottom - top)
    if (dispWidth < 4 || dispHeight < 4) return null

    // 映射到图片显示坐标
    const selXInImgDisp = left - imgRect.left
    const selYInImgDisp = top - imgRect.top

    const scaleX = img.naturalWidth / imgRect.width
    const scaleY = img.naturalHeight / imgRect.height

    // 转到自然尺寸坐标，并做边界裁切
    const natLeft = Math.max(0, Math.floor(selXInImgDisp * scaleX))
    const natTop = Math.max(0, Math.floor(selYInImgDisp * scaleY))
    const natWidth = Math.min(img.naturalWidth - natLeft, Math.floor(dispWidth * scaleX))
    const natHeight = Math.min(img.naturalHeight - natTop, Math.floor(dispHeight * scaleY))

    if (natWidth < 2 || natHeight < 2) return null
    return { left: natLeft, top: natTop, width: natWidth, height: natHeight }
  }, [selectionOverlayRect])

  // 鼠标事件：开始/拖动/结束
  const onMouseDown = useCallback((e: React.MouseEvent) => {
    if (!imageUrl || !overlayRef.current) return
    setDragging(true)
    setStartPt({ x: e.clientX, y: e.clientY })
    setEndPt({ x: e.clientX, y: e.clientY })
  }, [imageUrl])

  const onMouseMove = useCallback((e: React.MouseEvent) => {
    if (!dragging) return
    setEndPt({ x: e.clientX, y: e.clientY })
  }, [dragging])

  const onMouseUp = useCallback(async () => {
    if (!dragging) return
    setDragging(false)
    const rect = computeNaturalRectFromSelection()
    // 清空选择框
    setStartPt(null)
    setEndPt(null)
    if (rect) {
      await handleOcrSelection(rect)
    }
  }, [dragging, computeNaturalRectFromSelection, handleOcrSelection])

  return (
    <div style={{
      minHeight: '100dvh',
      padding: '24px',
      boxSizing: 'border-box',
      display: 'flex',
      flexDirection: 'column',
      gap: 16,
      maxWidth: 960,
      margin: '0 auto'
    }}>
      <h1>图片文字识别（tesseract.js）</h1>

      <div style={{ display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap' }}>
        <input type="file" accept="image/*" onChange={handleFileChange} />
        <div style={{ fontSize: 12, color: '#6b7280' }}>选择图片后会自动进行整图识别；也可在预览中框选进行区域识别。</div>
      </div>

      {status !== 'idle' && (
        <div style={{ width: '100%', maxWidth: 480 }}>
          <div style={{ fontSize: 12, color: '#555', marginBottom: 6 }}>状态：{status} {progress ? `(${progress}%)` : ''}</div>
          <div style={{ height: 8, background: '#eee', borderRadius: 4, overflow: 'hidden' }}>
            <div style={{ width: `${progress}%`, height: '100%', background: '#4f46e5', transition: 'width .2s' }} />
          </div>
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <div>
          <h3>预览</h3>
          <div
            ref={overlayRef}
            onMouseDown={onMouseDown}
            onMouseMove={onMouseMove}
            onMouseUp={onMouseUp}
            onMouseLeave={onMouseUp}
            style={{
              position: 'relative',
              width: '100%',
              aspectRatio: '4 / 3',
              background: '#fafafa',
              border: '1px solid #e5e7eb',
              borderRadius: 8,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              overflow: 'hidden',
              cursor: imageUrl ? 'crosshair' : 'default',
              userSelect: 'none',
            }}
          >
            {imageUrl ? (
              <img ref={imgRef} src={imageUrl} alt="preview" style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain', userSelect: 'none', pointerEvents: 'none' }} />
            ) : (
              <span style={{ color: '#9ca3af' }}>请选择一张图片</span>
            )}

            {/* 选择框可视化 */}
            {selectionOverlayRect && (
              <div
                style={{
                  position: 'absolute',
                  left: selectionOverlayRect.relLeft,
                  top: selectionOverlayRect.relTop,
                  width: selectionOverlayRect.width,
                  height: selectionOverlayRect.height,
                  border: '2px solid #4f46e5',
                  background: 'rgba(79,70,229,0.12)',
                  boxShadow: '0 0 0 1px rgba(79,70,229,0.5) inset',
                  borderRadius: 2,
                  pointerEvents: 'none'
                }}
              />
            )}
          </div>
          <div style={{ marginTop: 8, fontSize: 12, color: '#6b7280' }}>
            在预览区域按下并拖拽进行框选，松开后仅识别选中区域。
          </div>
        </div>

        <div>
          <h3>识别结果</h3>
          <textarea
            readOnly
            value={text}
            placeholder={status === 'idle' ? '识别文本将显示在这里' : '正在识别或结果即将显示…'}
            style={{ width: '100%', height: 300, padding: 12, resize: 'vertical' }}
          />
        </div>
      </div>
    </div>
  )
}

export default App
