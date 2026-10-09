
const connection = require('../database/connection');

module.exports = {

    // ==========================================================
    // LISTAR MOTORISTAS PENDENTES DE APROVAÇÃO
    // ==========================================================

    async listarPendentes(request, response) {
        try {
            const motoristas = await connection('motoristas')
                .join(
                    'usuarios',
                    'usuarios.id',
                    'motoristas.usuario_id'
                )
                .leftJoin(
                    'veiculos',
                    function () {
                        this.on(
                            'veiculos.motorista_id',
                            '=',
                            'motoristas.id'
                        ).andOn(
                            'veiculos.ativo',
                            '=',
                            connection.raw('?', [1])
                        );
                    }
                )
                .leftJoin(
                    'marcas',
                    'marcas.idMarca',
                    'veiculos.marca_id'
                )
                .leftJoin(
                    'modelos',
                    'modelos.idModelo',
                    'veiculos.modelo_id'
                )
                .leftJoin(
                    'categorias',
                    'categorias.id',
                    'veiculos.categoria_id'
                )
                .where('usuarios.tipo', 'MOTORISTA')
                .where('motoristas.status', 'PENDENTE')
                .select(
                    'motoristas.id as motorista_id',
                    'motoristas.cnh',
                    'motoristas.status',
                    'motoristas.created_at',
                    'usuarios.id as usuario_id',
                    'usuarios.nome',
                    'usuarios.email',
                    'usuarios.telefone',
                    'marcas.nome as marca',
                    'modelos.nome as modelo',
                    'veiculos.placa',
                    'veiculos.cor',
                    'veiculos.ano',
                    'categorias.nome as categoria'
                )
                .orderBy('motoristas.created_at', 'asc');

            return response.json({ motoristas });

        } catch (error) {
            console.error(
                'Erro ao listar motoristas pendentes:',
                error
            );

            return response.status(500).json({
                error: 'Erro ao listar motoristas pendentes.'
            });
        }
    },

    // ==========================================================
    // APROVAR OU BLOQUEAR MOTORISTA
    // ==========================================================

    async atualizarStatus(request, response) {
        const { motoristaId } = request.params;
        const { status } = request.body;

        // Somente estes status podem ser definidos por esta rota.
        const statusPermitidos = ['ATIVO', 'BLOQUEADO'];

        if (!statusPermitidos.includes(status)) {
            return response.status(400).json({
                error:
                    'Status inválido. Informe ATIVO ou BLOQUEADO.'
            });
        }

        try {
            const resultado = await connection.transaction(
                async (trx) => {

                    // Busca e bloqueia o registro durante a transação.
                    const motorista = await trx('motoristas')
                        .where('id', motoristaId)
                        .forUpdate()
                        .first();

                    if (!motorista) {
                        const error = new Error(
                            'Motorista não encontrado.'
                        );
                        error.statusCode = 404;
                        throw error;
                    }

                    // Impede aprovar/bloquear contas de usuário inativas.
                    const usuario = await trx('usuarios')
                        .where('id', motorista.usuario_id)
                        .select('id', 'tipo', 'status')
                        .first();

                    if (
                        !usuario ||
                        usuario.tipo !== 'MOTORISTA'
                    ) {
                        const error = new Error(
                            'Usuário vinculado ao motorista não encontrado.'
                        );
                        error.statusCode = 404;
                        throw error;
                    }

                    if (usuario.status !== 'ATIVO') {
                        const error = new Error(
                            'Não é possível alterar o status de um usuário inativo.'
                        );
                        error.statusCode = 409;
                        throw error;
                    }

                    // Atualiza o status e garante que fique offline.
                    await trx('motoristas')
                        .where('id', motoristaId)
                        .update({
                            status,
                            online: 0
                        });

                    const motoristaAtualizado =
                        await trx('motoristas')
                            .where('id', motoristaId)
                            .select(
                                'id',
                                'usuario_id',
                                'cnh',
                                'status',
                                'online'
                            )
                            .first();

                    return motoristaAtualizado;
                }
            );

            return response.json({
                message:
                    status === 'ATIVO'
                        ? 'Motorista aprovado com sucesso.'
                        : 'Motorista bloqueado com sucesso.',
                motorista: resultado
            });

        } catch (error) {
            if (error.statusCode) {
                return response.status(error.statusCode).json({
                    error: error.message
                });
            }

            console.error(
                'Erro ao atualizar status do motorista:',
                error
            );

            return response.status(500).json({
                error: 'Erro ao atualizar status do motorista.'
            });
        }
    }
};