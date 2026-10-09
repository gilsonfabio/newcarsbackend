
const connection = require('../database/connection');

module.exports = async function admin(request, response, next) {
    try {
        if (!request.user || !request.user.id) {
            return response.status(401).json({
                error: 'Usuário não autenticado.'
            });
        }

        const usuario = await connection('usuarios')
            .where('id', request.user.id)
            .select('id', 'tipo', 'status')
            .first();

        if (!usuario || usuario.status !== 'ATIVO') {
            return response.status(403).json({
                error: 'Usuário não está ativo.'
            });
        }

        // Ajuste conforme o tipo de administrador existente
        // no seu sistema.
        if (usuario.tipo !== 'ADMIN') {
            return response.status(403).json({
                error: 'Acesso permitido somente para administradores.'
            });
        }

        next();
    } catch (error) {
        console.error('Erro ao verificar administrador:', error);

        return response.status(500).json({
            error: 'Erro ao verificar permissões administrativas.'
        });
    }
};