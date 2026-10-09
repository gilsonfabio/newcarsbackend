const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');

require('dotenv/config');

let io;

function configurarSocket(server) {
    io = new Server(server, {
        cors: {
            origin: '*',
            methods: ['GET', 'POST', 'PUT'],
        },
    });

    // Autentica a conexão usando o JWT do aplicativo.
    io.use((socket, next) => {
        const token = socket.handshake.auth?.token;

        if (!token) {
            return next(new Error('Token não informado.'));
        }

        try {
            const usuario = jwt.verify(
                token,
                process.env.SECRET_JWT
            );

            const usuarioId =
                usuario.id ||
                usuario.usuario_id ||
                usuario.userId;

            if (!usuarioId) {
                return next(
                    new Error('Token não contém o ID do usuário.')
                );
            }

            socket.usuario = {
                id: String(usuarioId),
                tipo: usuario.tipo || usuario.type || null,
            };

            next();
        } catch (error) {
            next(new Error('Token inválido ou expirado.'));
        }
    });

    io.on('connection', (socket) => {
        const { id, tipo } = socket.usuario;

        // Sala privada do usuário autenticado.
        socket.join(`usuario:${id}`);

        console.log(
            `Socket conectado: usuário ${id}, tipo ${tipo || 'não informado'}`
        );

        socket.on('disconnect', (motivo) => {
            console.log(
                `Socket desconectado: usuário ${id}. Motivo: ${motivo}`
            );
        });
    });

    return io;

}

function obterIO() {
    if (!io) {
        throw new Error(
            'Socket.IO ainda não foi inicializado.'
        );
    }

    return io;

}

module.exports = {
    configurarSocket,
    obterIO,
};
