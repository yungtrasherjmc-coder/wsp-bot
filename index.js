require('dotenv').config()
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js')
const qrcode = require('qrcode-terminal')
const fs = require('fs')
const OpenAI = require('openai')

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-gpu',
            '--no-first-run',
            '--no-default-browser-check',
            '--disable-dev-shm-usage'
        ]
    }
})

// Cargar recordatorios
let recordatorios = []
if (fs.existsSync('recordatorios.json')) {
    recordatorios = JSON.parse(fs.readFileSync('recordatorios.json'))
}

function guardarRecordatorios() {
    fs.writeFileSync('recordatorios.json', JSON.stringify(recordatorios, null, 2))
}

// Revisar recordatorios cada 10 segundos
setInterval(async () => {
    const ahora = Date.now()
    for (const rec of recordatorios) {
        if (!rec.enviado && ahora >= rec.tiempo) {
            await client.sendMessage(rec.numero, `⏰ Recordatorio: ${rec.mensaje}`)
            rec.enviado = true
            guardarRecordatorios()
        }
    }
}, 10000)

// Interpretar texto con IA
async function interpretarRecordatorio(texto) {
    const respuesta = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
            {
                role: 'system',
                content: `Eres un asistente que extrae recordatorios de mensajes de voz.
Responde SOLO en JSON con este formato:
{"mensaje": "descripcion del recordatorio", "minutos": numero}
Si no entiendes el mensaje responde: {"error": "no entendido"}`
            },
            { role: 'user', content: texto }
        ]
    })
    return JSON.parse(respuesta.choices[0].message.content)
}

client.on('qr', (qr) => {
    const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(qr)}`
    console.log('📱 Escanea el QR aquí:', qrUrl)
})

client.on('ready', () => {
    console.log('✅ Bot conectado!')
})

client.on('message_create', async (msg) => {
    const numero = msg.from
    const texto = msg.body.trim()

    // Mensaje de texto normal
    if (msg.type === 'chat') {
        if (texto === '!hola') {
            msg.reply('👋 Hola! Puedes enviarme un audio de voz diciendo tu recordatorio, o escribir:\n!recordar [minutos] [mensaje]')
            return
        }

        if (texto.startsWith('!recordar')) {
            const partes = texto.split(' ')
            const minutos = parseInt(partes[1])
            const mensaje = partes.slice(2).join(' ')
            if (!minutos || !mensaje) {
                msg.reply('Formato: !recordar [minutos] [mensaje]\nEjemplo: !recordar 10 Tomar agua')
                return
            }
            const tiempo = Date.now() + minutos * 60 * 1000
            recordatorios.push({ numero, mensaje, tiempo, enviado: false })
            guardarRecordatorios()
            msg.reply(`✅ Recordatorio guardado! Te aviso en ${minutos} minuto(s): "${mensaje}"`)
        }

        if (texto === '!mis recordatorios') {
            const pendientes = recordatorios.filter(r => r.numero === numero && !r.enviado)
            if (pendientes.length === 0) {
                msg.reply('No tienes recordatorios pendientes.')
            } else {
                const lista = pendientes.map((r, i) => {
                    const mins = Math.round((r.tiempo - Date.now()) / 60000)
                    return `${i + 1}. "${r.mensaje}" - en ${mins} min`
                }).join('\n')
                msg.reply(`📋 Tus recordatorios:\n${lista}`)
            }
        }
    }

    // Audio de voz
    if (msg.type === 'ptt' || msg.type === 'audio') {
        msg.reply('🎤 Escuchando tu audio...')
        try {
            const media = await msg.downloadMedia()
            const audioBuffer = Buffer.from(media.data, 'base64')
            const audioPath = `audio_${Date.now()}.ogg`
            fs.writeFileSync(audioPath, audioBuffer)

            // Transcribir con Whisper
            const transcripcion = await openai.audio.transcriptions.create({
                file: fs.createReadStream(audioPath),
                model: 'whisper-1',
                language: 'es'
            })

            fs.unlinkSync(audioPath) // borrar archivo temporal

            console.log('Transcripcion:', transcripcion.text)
            msg.reply(`📝 Entendí: "${transcripcion.text}"`)

            // Interpretar con IA
            const resultado = await interpretarRecordatorio(transcripcion.text)

            if (resultado.error) {
                msg.reply('No entendí bien el recordatorio. Intenta de nuevo.')
                return
            }

            const tiempo = Date.now() + resultado.minutos * 60 * 1000
            recordatorios.push({ numero, mensaje: resultado.mensaje, tiempo, enviado: false })
            guardarRecordatorios()
            msg.reply(`✅ Recordatorio guardado!\n"${resultado.mensaje}" en ${resultado.minutos} minuto(s)`)

        } catch (err) {
            console.error('Error procesando audio:', err)
            msg.reply('Hubo un error procesando el audio. Intenta de nuevo.')
        }
    }
})

client.initialize()