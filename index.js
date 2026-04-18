require('dotenv').config()

const dns = require('dns')
dns.setDefaultResultOrder('ipv4first')

const { Client, RemoteAuth } = require('whatsapp-web.js')
const { MongoStore } = require('wwebjs-mongo')
const mongoose = require('mongoose')
const fs = require('fs')
const OpenAI = require('openai')
const { MongoClient, ObjectId } = require('mongodb')

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

let db
let recordatoriosCol
let client

async function conectarMongo() {
    // ✅ Conexión nativa para recordatorios
    const clienteMongo = new MongoClient(process.env.MONGODB_URI)
    await clienteMongo.connect()
    db = clienteMongo.db('wsp-bot')
    recordatoriosCol = db.collection('recordatorios')

    await recordatoriosCol.createIndex({ numero: 1 })
    await recordatoriosCol.createIndex({ enviado: 1, tiempo: 1 })

    // ✅ Conexión mongoose para sesión de WhatsApp
    await mongoose.connect(process.env.MONGODB_URI)

    console.log('✅ MongoDB conectado!')
}

function limpiarJSON(texto) {
    return texto
        .replace(/```json/g, '')
        .replace(/```/g, '')
        .trim()
}

function horaActualChile() {
    return new Date().toLocaleString('es-CL', { timeZone: 'America/Santiago' })
}

function calcularProximoTiempo(rec) {
    const ahora = new Date()
    const ahoraChile = new Date(ahora.toLocaleString('en-US', { timeZone: 'America/Santiago' }))

    const [hora, minuto] = rec.horaRepeticion.split(':').map(Number)

    let candidato = new Date(ahoraChile)
    candidato.setHours(hora, minuto, 0, 0)

    if (candidato <= ahoraChile) {
        candidato.setDate(candidato.getDate() + 1)
    }

    const diasSemana = {
        'domingo': 0, 'lunes': 1, 'martes': 2, 'miércoles': 3,
        'jueves': 4, 'viernes': 5, 'sábado': 6
    }

    for (let i = 0; i < 7; i++) {
        const diaCandidato = candidato.getDay()
        const nombreDia = Object.keys(diasSemana).find(k => diasSemana[k] === diaCandidato)

        const esDiaSaltado = rec.diasSaltar && rec.diasSaltar.some(d => {
            const fechaSaltar = new Date(d)
            return fechaSaltar.toDateString() === candidato.toDateString()
        })

        const esDiaPermitido = rec.diasSemana.includes('todos') ||
            rec.diasSemana.includes(nombreDia)

        if (esDiaPermitido && !esDiaSaltado) {
            return candidato.getTime()
        }

        candidato.setDate(candidato.getDate() + 1)
    }

    return null
}

async function interpretarMensaje(texto, recordatoriosRepetitivos) {
    const horaChile = horaActualChile()

    const listaRepetitivos = recordatoriosRepetitivos.length > 0
        ? recordatoriosRepetitivos.map((r, i) =>
            `${i + 1}. "${r.mensaje}" - ${r.diasSemana.join(', ')} a las ${r.horaRepeticion}`
        ).join('\n')
        : 'ninguno'

    const respuesta = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
            {
                role: 'system',
                content: `Eres un asistente que interpreta mensajes sobre recordatorios en español chileno informal.
La hora actual en Chile es: ${horaChile}

Recordatorios repetitivos activos del usuario:
${listaRepetitivos}

Responde SOLO en JSON con uno de estos formatos:

1. Recordatorio normal (una sola vez):
{"tipo": "normal", "mensaje": "descripcion", "minutos": numero}

2. Recordatorio repetitivo:
{"tipo": "repetitivo", "mensaje": "descripcion", "diasSemana": ["lunes","martes",...], "horaRepeticion": "HH:MM"}
Para todos los días usa: {"diasSemana": ["todos"]}
Para lunes a viernes usa: {"diasSemana": ["lunes","martes","miércoles","jueves","viernes"]}

3. Saltar días de un repetitivo:
{"tipo": "saltar", "mensajeBuscado": "parte del mensaje del recordatorio", "fechasSaltar": ["YYYY-MM-DD", ...]}

4. Cancelar repetitivo completo:
{"tipo": "cancelar_repetitivo", "mensajeBuscado": "parte del mensaje del recordatorio"}

5. No es un recordatorio:
{"tipo": "error", "mensaje": "no es recordatorio"}

Ejemplos:
- "recuérdame todos los días a las 9pm tomar agua" → {"tipo": "repetitivo", "mensaje": "tomar agua", "diasSemana": ["todos"], "horaRepeticion": "21:00"}
- "de lunes a viernes a las 8am recuérdame la reunión" → {"tipo": "repetitivo", "mensaje": "reunión", "diasSemana": ["lunes","martes","miércoles","jueves","viernes"], "horaRepeticion": "08:00"}
- "mañana no me recuerdes la reunión" → {"tipo": "saltar", "mensajeBuscado": "reunión", "fechasSaltar": ["YYYY-MM-DD de mañana"]}
- "esta semana no me recuerdes el ejercicio" → {"tipo": "saltar", "mensajeBuscado": "ejercicio", "fechasSaltar": ["YYYY-MM-DD lunes", ..., "YYYY-MM-DD domingo"]}
- "cancela el recordatorio de la reunión" → {"tipo": "cancelar_repetitivo", "mensajeBuscado": "reunión"}
- "recuérdame en 30 minutos tomar agua" → {"tipo": "normal", "mensaje": "tomar agua", "minutos": 30}
- "hola cómo estás" → {"tipo": "error", "mensaje": "no es recordatorio"}

IMPORTANTE para fechasSaltar: usa fechas reales en formato YYYY-MM-DD basándote en la hora actual.`
            },
            { role: 'user', content: texto }
        ]
    })
    try {
        const contenido = respuesta.choices[0].message.content
        return JSON.parse(limpiarJSON(contenido))
    } catch {
        return { tipo: 'error', mensaje: 'no es recordatorio' }
    }
}

async function enviarRecordatorio(rec) {
    const aviso = rec.aviso || 1
    const avisoTexto = aviso === 1 ? '' : `\n_(${aviso}° aviso)_`

    await recordatoriosCol.updateOne(
        { _id: rec._id },
        {
            $set: {
                enviado: true,
                esperandoReaccion: true,
                ultimoAviso: Date.now(),
                aviso
            }
        }
    )

    try {
        const sent = await client.sendMessage(
            rec.numero,
            `⏰ *Recordatorio:* ${rec.mensaje}${avisoTexto}\n\n👍 Confirmar | ❤️ +10 min | ⏰ +30 min`
        )
        await recordatoriosCol.updateOne(
            { _id: rec._id },
            { $set: { msgId: sent.id._serialized } }
        )
    } catch (err) {
        console.log(`❌ Error enviando recordatorio: ${err.message}`)
    }
}

async function procesarMensaje(msg, numero, texto) {
    const repetitivosActivos = await recordatoriosCol.find({
        numero,
        repetitivo: true,
        cancelado: { $ne: true }
    }).toArray()

    const resultado = await interpretarMensaje(texto, repetitivosActivos)

    // ✅ Recordatorio normal
    if (resultado.tipo === 'normal') {
        const cantidad = await recordatoriosCol.countDocuments({
            numero,
            enviado: false,
            completado: { $ne: true }
        })
        if (cantidad >= 10) {
            msg.reply('⚠️ Ya tienes 10 recordatorios pendientes. Usa !lista para verlos o !cancelar para eliminar alguno.')
            return
        }

        const tiempo = Date.now() + resultado.minutos * 60 * 1000
        const horaAviso = new Date(tiempo).toLocaleString('es-CL', {
            timeZone: 'America/Santiago',
            hour: '2-digit',
            minute: '2-digit'
        })

        await recordatoriosCol.insertOne({
            numero,
            mensaje: resultado.mensaje,
            tiempo,
            enviado: false,
            esperandoReaccion: false,
            completado: false,
            repetitivo: false,
            aviso: 1,
            msgId: null
        })
        msg.reply(`✅ *Recordatorio guardado*\n📝 "${resultado.mensaje}"\n🕐 Te aviso a las ${horaAviso} (en ${resultado.minutos} minuto(s))`)
        return
    }

    // ✅ Recordatorio repetitivo
    if (resultado.tipo === 'repetitivo') {
        const plantilla = {
            numero,
            mensaje: resultado.mensaje,
            diasSemana: resultado.diasSemana,
            horaRepeticion: resultado.horaRepeticion,
            repetitivo: true,
            cancelado: false,
            diasSaltar: [],
            enviado: false,
            esperandoReaccion: false,
            completado: false,
            aviso: 1,
            msgId: null
        }

        const proximoTiempo = calcularProximoTiempo(plantilla)
        if (!proximoTiempo) {
            msg.reply('⚠️ No pude calcular el próximo aviso. Intenta de nuevo.')
            return
        }

        plantilla.tiempo = proximoTiempo

        await recordatoriosCol.insertOne(plantilla)

        const dias = resultado.diasSemana.includes('todos')
            ? 'todos los días'
            : resultado.diasSemana.join(', ')

        const horaAviso = new Date(proximoTiempo).toLocaleString('es-CL', {
            timeZone: 'America/Santiago',
            weekday: 'long',
            hour: '2-digit',
            minute: '2-digit'
        })

        msg.reply(`✅ *Recordatorio repetitivo guardado*\n📝 "${resultado.mensaje}"\n📅 ${dias} a las ${resultado.horaRepeticion}\n🕐 Próximo aviso: ${horaAviso}`)
        return
    }

    // ✅ Saltar días
    if (resultado.tipo === 'saltar') {
        const repetitivos = await recordatoriosCol.find({
            numero,
            repetitivo: true,
            cancelado: { $ne: true }
        }).toArray()

        const encontrado = repetitivos.find(r =>
            r.mensaje.toLowerCase().includes(resultado.mensajeBuscado.toLowerCase()) ||
            resultado.mensajeBuscado.toLowerCase().includes(r.mensaje.toLowerCase())
        )

        if (!encontrado) {
            msg.reply(`⚠️ No encontré un recordatorio repetitivo que coincida con "${resultado.mensajeBuscado}".\nUsa !lista para ver tus repetitivos.`)
            return
        }

        const fechasSaltar = resultado.fechasSaltar.map(f => new Date(f).getTime())

        await recordatoriosCol.updateOne(
            { _id: encontrado._id },
            { $push: { diasSaltar: { $each: fechasSaltar } } }
        )

        const fechasTexto = resultado.fechasSaltar.map(f =>
            new Date(f).toLocaleDateString('es-CL', {
                timeZone: 'America/Santiago',
                weekday: 'long',
                day: 'numeric',
                month: 'long'
            })
        ).join(', ')

        const diasNormales = encontrado.diasSemana.includes('todos')
            ? 'todos los días'
            : encontrado.diasSemana.join(', ')

        msg.reply(`✅ Entendido, no te recuerdo "${encontrado.mensaje}" el ${fechasTexto}.\n🔁 Los demás días (${diasNormales} a las ${encontrado.horaRepeticion}) sigue normal.`)
        return
    }

    // ✅ Cancelar repetitivo completo
    if (resultado.tipo === 'cancelar_repetitivo') {
        const repetitivos = await recordatoriosCol.find({
            numero,
            repetitivo: true,
            cancelado: { $ne: true }
        }).toArray()

        const encontrado = repetitivos.find(r =>
            r.mensaje.toLowerCase().includes(resultado.mensajeBuscado.toLowerCase()) ||
            resultado.mensajeBuscado.toLowerCase().includes(r.mensaje.toLowerCase())
        )

        if (!encontrado) {
            msg.reply(`⚠️ No encontré un recordatorio repetitivo que coincida con "${resultado.mensajeBuscado}".\nUsa !lista para ver tus repetitivos.`)
            return
        }

        await recordatoriosCol.updateOne(
            { _id: encontrado._id },
            { $set: { cancelado: true, enviado: true, completado: true } }
        )

        msg.reply(`🗑️ Recordatorio repetitivo cancelado: "${encontrado.mensaje}"\nNo recibirás más avisos de este recordatorio.`)
        return
    }

    // ✅ No es recordatorio
    if (resultado.tipo === 'error') {
        msg.reply('No entendí eso como un recordatorio 🤔\n\nPuedes decirme algo como:\n"recuérdame en 30 minutos tomar agua"\n"recuérdame a las 7pm llamar al médico"\n"todos los días a las 9am recuérdame hacer ejercicio"\n"de lunes a viernes a las 8am recuérdame la reunión"\n"mañana no me recuerdes la reunión"\n\nO usa *!lista* para ver tus recordatorios.')
        return
    }
}

async function iniciar() {
    await conectarMongo()

    const store = new MongoStore({ mongoose })

    // ✅ Client definido aquí para usar RemoteAuth
    client = new Client({
        authStrategy: new RemoteAuth({
            store,
            backupSyncIntervalMs: 300000
        }),
        puppeteer: {
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu', '--disable-dev-shm-usage']
        }
    })

    // ✅ Revisar recordatorios cada 10 segundos
    setInterval(async () => {
        if (!recordatoriosCol) return

        const ahora = Date.now()

        const pendientes = await recordatoriosCol.find({
            enviado: false,
            tiempo: { $lte: ahora },
            completado: { $ne: true }
        }).toArray()

        for (const rec of pendientes) {
            await enviarRecordatorio(rec)
        }

        const sinReaccion = await recordatoriosCol.find({
            esperandoReaccion: true,
            ultimoAviso: { $lte: ahora - 10 * 60 * 1000 }
        }).toArray()

        for (const rec of sinReaccion) {
            await recordatoriosCol.updateOne(
                { _id: rec._id },
                {
                    $set: {
                        enviado: false,
                        esperandoReaccion: false,
                        aviso: (rec.aviso || 1) + 1
                    }
                }
            )
        }
    }, 10000)

    client.on('qr', (qr) => {
        const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(qr)}`
        console.log('📱 Escanea el QR aquí:', qrUrl)
    })

    client.on('ready', () => {
        console.log('✅ Bot conectado!')
    })

    client.on('remote_session_saved', () => {
        console.log('✅ Sesión guardada en MongoDB!')
    })

    client.on('message_reaction', async (reaction) => {
        const emoji = reaction.reaction
        const msgId = reaction.msgId._serialized
        const numero = reaction.senderId

        const rec = await recordatoriosCol.findOne({ msgId, esperandoReaccion: true })
        if (!rec) return

        // 👍 Confirmar
        if (emoji === '👍') {
            await recordatoriosCol.updateOne(
                { _id: rec._id },
                { $set: { esperandoReaccion: false, completado: true } }
            )

            if (rec.repetitivo) {
                const proximoTiempo = calcularProximoTiempo(rec)
                if (proximoTiempo) {
                    const horaAviso = new Date(proximoTiempo).toLocaleString('es-CL', {
                        timeZone: 'America/Santiago',
                        weekday: 'long',
                        hour: '2-digit',
                        minute: '2-digit'
                    })
                    await recordatoriosCol.insertOne({
                        ...rec,
                        _id: new ObjectId(),
                        enviado: false,
                        esperandoReaccion: false,
                        completado: false,
                        tiempo: proximoTiempo,
                        aviso: 1,
                        msgId: null,
                        ultimoAviso: null
                    })
                    await client.sendMessage(numero, `✅ ¡Perfecto! Recordatorio completado.\n🔁 Próximo aviso: ${horaAviso}`)
                }
            } else {
                await client.sendMessage(numero, '✅ ¡Perfecto! Recordatorio completado.')
            }
            return
        }

        // ❤️ Posponer 10 minutos
        if (emoji === '❤️') {
            await recordatoriosCol.updateOne(
                { _id: rec._id },
                {
                    $set: {
                        esperandoReaccion: false,
                        enviado: false,
                        tiempo: Date.now() + 10 * 60 * 1000,
                        aviso: 1
                    }
                }
            )
            await client.sendMessage(numero, '❤️ Ok, te recuerdo en 10 minutos.')
            return
        }

        // ⏰ Posponer 30 minutos
        if (emoji === '⏰') {
            await recordatoriosCol.updateOne(
                { _id: rec._id },
                {
                    $set: {
                        esperandoReaccion: false,
                        enviado: false,
                        tiempo: Date.now() + 30 * 60 * 1000,
                        aviso: 1
                    }
                }
            )
            await client.sendMessage(numero, '⏰ Ok, te recuerdo en 30 minutos.')
            return
        }
    })

    client.on('message', async (msg) => {
        if (msg.fromMe) return

        const numero = msg.from
        const texto = msg.body.trim().toLowerCase()

        // ✅ Ver lista
        if (texto === '!lista') {
            const normales = await recordatoriosCol.find({
                numero,
                enviado: false,
                completado: { $ne: true },
                repetitivo: { $ne: true }
            }).toArray()

            const repetitivos = await recordatoriosCol.find({
                numero,
                repetitivo: true,
                cancelado: { $ne: true }
            }).toArray()

            let respuesta = ''

            if (normales.length === 0 && repetitivos.length === 0) {
                msg.reply('📭 No tienes recordatorios pendientes.')
                return
            }

            if (normales.length > 0) {
                const lista = normales.map((r, i) => {
                    const fecha = new Date(r.tiempo).toLocaleString('es-CL', {
                        timeZone: 'America/Santiago',
                        hour: '2-digit',
                        minute: '2-digit'
                    })
                    return `${i + 1}. "${r.mensaje}" - 🕐 ${fecha}`
                }).join('\n')
                respuesta += `📋 *Recordatorios pendientes:*\n${lista}`
            }

            if (repetitivos.length > 0) {
                const listaRep = repetitivos.map((r, i) => {
                    const dias = r.diasSemana.includes('todos') ? 'todos los días' : r.diasSemana.join(', ')
                    return `${i + 1}. "${r.mensaje}" - ${dias} a las ${r.horaRepeticion}`
                }).join('\n')
                respuesta += `${respuesta ? '\n\n' : ''}🔁 *Recordatorios repetitivos:*\n${listaRep}`
            }

            msg.reply(respuesta)
            return
        }

        // ✅ Cancelar por comando
        if (texto.startsWith('!cancelar')) {
            const num = parseInt(texto.split(' ')[1]) - 1
            const pendientes = await recordatoriosCol.find({
                numero,
                enviado: false,
                completado: { $ne: true },
                repetitivo: { $ne: true }
            }).toArray()

            if (pendientes[num]) {
                await recordatoriosCol.updateOne(
                    { _id: pendientes[num]._id },
                    { $set: { enviado: true, completado: true } }
                )
                msg.reply(`🗑️ Recordatorio cancelado: "${pendientes[num].mensaje}"`)
            } else {
                msg.reply('⚠️ No encontré ese recordatorio. Usa !lista para ver los pendientes.')
            }
            return
        }

        // ✅ Audio
        if (msg.type === 'ptt' || msg.type === 'audio') {
            msg.reply('🎤 Procesando tu audio...')
            const audioPath = `audio_${Date.now()}.ogg`
            try {
                const media = await msg.downloadMedia()
                const audioBuffer = Buffer.from(media.data, 'base64')
                fs.writeFileSync(audioPath, audioBuffer)

                const transcripcion = await openai.audio.transcriptions.create({
                    file: fs.createReadStream(audioPath),
                    model: 'whisper-1',
                    language: 'es'
                })

                const textoAudio = transcripcion.text
                console.log('🎤 Transcripción:', textoAudio)

                await procesarMensaje(msg, numero, textoAudio)

            } catch (err) {
                console.error('❌ Error procesando audio:', err)
                msg.reply('Hubo un error procesando el audio. Intenta de nuevo.')
            } finally {
                if (fs.existsSync(audioPath)) {
                    fs.unlinkSync(audioPath)
                }
            }
            return
        }

        // ✅ Texto normal
        if (msg.type === 'chat') {
            await procesarMensaje(msg, numero, texto)
        }
    })

    client.initialize()
}

process.on('SIGINT', async () => {
    console.log('🛑 Cerrando bot...')
    await client.destroy()
    process.exit(0)
})

iniciar()