require('dotenv').config()
const { Client, LocalAuth, Buttons } = require('whatsapp-web.js')
const qrcode = require('qrcode-terminal')
const fs = require('fs')
const OpenAI = require('openai')

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu', '--disable-dev-shm-usage']
    }
})

let recordatorios = []
if (fs.existsSync('recordatorios.json')) {
    recordatorios = JSON.parse(fs.readFileSync('recordatorios.json'))
}

function guardarRecordatorios() {
    fs.writeFileSync('recordatorios.json', JSON.stringify(recordatorios, null, 2))
}

async function interpretarRecordatorio(texto) {
    const respuesta = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
            {
                role: 'system',
                content: `Eres un asistente que extrae recordatorios de mensajes en español chileno informal.
Responde SOLO en JSON con este formato:
{"mensaje": "descripcion del recordatorio", "minutos": numero}
Si el mensaje no es un recordatorio responde: {"error": "no es recordatorio"}
Ejemplos:
- "recordáme en 30 minutos tomar agua" → {"mensaje": "tomar agua", "minutos": 30}
- "en una hora tengo reunión" → {"mensaje": "reunión", "minutos": 60}
- "en un ratito llama al dentista" → {"mensaje": "llamar al dentista", "minutos": 15}
- "hola cómo estás" → {"error": "no es recordatorio"}`
            },
            { role: 'user', content: texto }
        ]
    })
    try {
        return JSON.parse(respuesta.choices[0].message.content)
    } catch {
        return { error: 'no es recordatorio' }
    }
}

async function enviarRecordatorio(rec) {
    try {
        const btnMsg = new Buttons(
            `⏰ *Recordatorio:* ${rec.mensaje}`,
            [
                { body: '✅ Confirmar' },
                { body: '⏰ Posponer 10 min' },
                { body: '✏️ Posponer por...' }
            ],
            'Recordatorio',
            '¿Qué quieres hacer?'
        )
        await client.sendMessage(rec.numero, btnMsg)
    } catch {
        // Si los botones no funcionan, enviar texto plano
        await client.sendMessage(rec.numero,
            `⏰ *Recordatorio:* ${rec.mensaje}\n\nResponde:\n✅ *confirmar* - ya lo hice\n⏰ *posponer 10* - en 10 minutos\n✏️ *posponer X* - en X minutos (ej: posponer 30)`)
    }
    rec.enviado = true
    rec.esperandoRespuesta = true
    guardarRecordatorios()
}

// Revisar recordatorios cada 10 segundos
setInterval(async () => {
    const ahora = Date.now()
    for (const rec of recordatorios) {
        if (!rec.enviado && ahora >= rec.tiempo) {
            await enviarRecordatorio(rec)
        }
    }
}, 10000)

client.on('qr', (qr) => {
    const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(qr)}`
    console.log('📱 Escanea el QR aquí:', qrUrl)
})

client.on('ready', () => {
    console.log('✅ Bot conectado!')
})

client.on('button_response', async (msg) => {
    const numero = msg.from
    const respuesta = msg.selectedButtonId || msg.body

    const esperando = recordatorios.find(r => r.numero === numero && r.esperandoRespuesta)
    if (!esperando) return

    if (respuesta === '✅ Confirmar') {
        esperando.esperandoRespuesta = false
        guardarRecordatorios()
        await client.sendMessage(numero, '✅ ¡Perfecto! Recordatorio completado.')
        return
    }

    if (respuesta === '⏰ Posponer 10 min') {
        esperando.esperandoRespuesta = false
        esperando.enviado = false
        esperando.tiempo = Date.now() + 10 * 60 * 1000
        guardarRecordatorios()
        await client.sendMessage(numero, '⏰ Ok, te recuerdo en 10 minutos.')
        return
    }

    if (respuesta === '✏️ Posponer por...') {
        esperando.esperandoRespuesta = false
        esperando.esperandoPersonalizado = true
        guardarRecordatorios()
        await client.sendMessage(numero, '✏️ ¿En cuántos minutos quieres que te recuerde? Responde solo el número.\nEjemplo: *30*')
        return
    }
})

client.on('message_create', async (msg) => {
    if (msg.fromMe) return
    const numero = msg.from
    const texto = msg.body.trim().toLowerCase()

    // Comando: ver lista
    if (texto === '!lista') {
        const pendientes = recordatorios.filter(r => r.numero === numero && !r.enviado)
        if (pendientes.length === 0) {
            msg.reply('📭 No tienes recordatorios pendientes.')
        } else {
            const lista = pendientes.map((r, i) => {
                const mins = Math.round((r.tiempo - Date.now()) / 60000)
                return `${i + 1}. "${r.mensaje}" - en ${mins} min`
            }).join('\n')
            msg.reply(`📋 *Tus recordatorios pendientes:*\n${lista}`)
        }
        return
    }

    // Comando: cancelar
    if (texto.startsWith('!cancelar')) {
        const num = parseInt(texto.split(' ')[1]) - 1
        const pendientes = recordatorios.filter(r => r.numero === numero && !r.enviado)
        if (pendientes[num]) {
            pendientes[num].enviado = true
            guardarRecordatorios()
            msg.reply(`🗑️ Recordatorio cancelado: "${pendientes[num].mensaje}"`)
        } else {
            msg.reply('⚠️ No encontré ese recordatorio. Usa !lista para ver los pendientes.')
        }
        return
    }

    // Respuesta personalizada para posponer
    const personalizado = recordatorios.find(r => r.numero === numero && r.esperandoPersonalizado)
    if (personalizado) {
        const minutos = parseInt(texto)
        if (!isNaN(minutos) && minutos > 0) {
            personalizado.esperandoPersonalizado = false
            personalizado.enviado = false
            personalizado.tiempo = Date.now() + minutos * 60 * 1000
            guardarRecordatorios()
            msg.reply(`⏰ Ok, te recuerdo en ${minutos} minutos.`)
        } else {
            msg.reply('⚠️ Por favor responde solo con un número. Ejemplo: *30*')
        }
        return
    }

    // Respuesta en texto plano a recordatorio (por si los botones no funcionan)
    const esperando = recordatorios.find(r => r.numero === numero && r.esperandoRespuesta)
    if (esperando) {
        if (texto === 'confirmar' || texto === '✅ confirmar') {
            esperando.esperandoRespuesta = false
            guardarRecordatorios()
            msg.reply('✅ ¡Perfecto! Recordatorio completado.')
            return
        }
        if (texto === 'posponer 10' || texto === '⏰ posponer 10 min') {
            esperando.esperandoRespuesta = false
            esperando.enviado = false
            esperando.tiempo = Date.now() + 10 * 60 * 1000
            guardarRecordatorios()
            msg.reply('⏰ Ok, te recuerdo en 10 minutos.')
            return
        }
        if (texto.startsWith('posponer ')) {
            const minutos = parseInt(texto.split(' ')[1])
            if (!isNaN(minutos) && minutos > 0) {
                esperando.esperandoRespuesta = false
                esperando.enviado = false
                esperando.tiempo = Date.now() + minutos * 60 * 1000
                guardarRecordatorios()
                msg.reply(`⏰ Ok, te recuerdo en ${minutos} minutos.`)
                return
            }
        }
    }

    // Audio de voz
    if (msg.type === 'ptt' || msg.type === 'audio') {
        msg.reply('🎤 Procesando tu audio...')
        try {
            const media = await msg.downloadMedia()
            const audioBuffer = Buffer.from(media.data, 'base64')
            const audioPath = `audio_${Date.now()}.ogg`
            fs.writeFileSync(audioPath, audioBuffer)

            const transcripcion = await openai.audio.transcriptions.create({
                file: fs.createReadStream(audioPath),
                model: 'whisper-1',
                language: 'es'
            })

            fs.unlinkSync(audioPath)
            const textoAudio = transcripcion.text
            console.log('Transcripción:', textoAudio)

            const resultado = await interpretarRecordatorio(textoAudio)

            if (resultado.error) {
                msg.reply(`Entendí: "${textoAudio}"\n\nPero no encontré un recordatorio ahí. Puedes decirme algo como: "recuérdame en 30 minutos hacer X"`)
                return
            }

            const tiempo = Date.now() + resultado.minutos * 60 * 1000
            recordatorios.push({ numero, mensaje: resultado.mensaje, tiempo, enviado: false, esperandoRespuesta: false, esperandoPersonalizado: false })
            guardarRecordatorios()
            msg.reply(`✅ *Recordatorio guardado*\n📝 "${resultado.mensaje}"\n⏱️ Te aviso en ${resultado.minutos} minuto(s)`)

        } catch (err) {
            console.error('Error procesando audio:', err)
            msg.reply('Hubo un error procesando el audio. Intenta de nuevo.')
        }
        return
    }

    // Texto normal → interpretar como recordatorio
    if (msg.type === 'chat') {
        const resultado = await interpretarRecordatorio(texto)

        if (resultado.error) {
            msg.reply('No entendí eso como un recordatorio 🤔\n\nPuedes decirme algo como:\n"recuérdame en 30 minutos tomar agua"\n\nO usa *!lista* para ver tus recordatorios pendientes.')
            return
        }

        const tiempo = Date.now() + resultado.minutos * 60 * 1000
        recordatorios.push({ numero, mensaje: resultado.mensaje, tiempo, enviado: false, esperandoRespuesta: false, esperandoPersonalizado: false })
        guardarRecordatorios()
        msg.reply(`✅ *Recordatorio guardado*\n📝 "${resultado.mensaje}"\n⏱️ Te aviso en ${resultado.minutos} minuto(s)`)
    }
})

client.initialize()