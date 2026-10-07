const connection = require('../database/connection');

module.exports = {

    // ==========================================================
    // ATUALIZAR LOCALIZAÇÃO E STATUS ONLINE DO MOTORISTA
    // ==========================================================

    async atualizarLocalizacao(request, response) {
        try {
            const usuarioId = request.user.id;

            const {
                latitude,
                longitude,
                online
            } = request.body;

            // ==========================================
            // VALIDAÇÃO DO ONLINE
            // ==========================================

            if (
                online !== undefined &&
                typeof online !== 'boolean'
            ) {

                return response.status(400).json({
                    error: 'O campo online deve ser booleano.'
                });

            }

            // ==========================================
            // BUSCA O MOTORISTA
            // ==========================================

            const motorista = await connection('motoristas')
                .join(
                    'usuarios',
                    'usuarios.id',
                    'motoristas.usuario_id'
                )
                .where(
                    'motoristas.usuario_id',
                    usuarioId
                )
                .where(
                    'usuarios.tipo',
                    'MOTORISTA'
                )
                .where(
                    'usuarios.status',
                    'ATIVO'
                )
                .select(
                    'motoristas.id',
                    'motoristas.usuario_id',
                    'motoristas.cnh',
                    'motoristas.status',
                    'motoristas.online',
                    'motoristas.latitude',
                    'motoristas.longitude'
                )
                .first();

            if (!motorista) {

                return response.status(403).json({
                    error:
                        'Cadastro de motorista não encontrado ou usuário não autorizado.'
                });

            }

            // ==========================================
            // MOTORISTA PRECISA ESTAR APROVADO
            // ==========================================

            if (motorista.status !== 'APROVADO') {
                return response.status(403).json({
                    error:
                        'O motorista ainda não está aprovado.'
                });
            }

            // ==========================================
            // VALIDAÇÃO DA LOCALIZAÇÃO
            // ==========================================

            const possuiLatitude =
                latitude !== undefined &&
                latitude !== null;

            const possuiLongitude =
                longitude !== undefined &&
                longitude !== null;

            /*
             * Se uma coordenada foi enviada,
             * as duas precisam ser enviadas.
             */

            if (
                possuiLatitude !== possuiLongitude
            ) {
                return response.status(400).json({
                    error:
                        'Latitude e longitude devem ser informadas juntas.'
                });
            }

            // ==========================================
            // PREPARA ATUALIZAÇÃO
            // ==========================================

            const dadosAtualizacao = {};

            // ==========================================
            // ATUALIZA LOCALIZAÇÃO
            // ==========================================

            if (
                possuiLatitude &&
                possuiLongitude
            ) {

                const latitudeNumero =
                    Number(latitude);

                const longitudeNumero =
                    Number(longitude);

                if (
                    !Number.isFinite(latitudeNumero) ||
                    !Number.isFinite(longitudeNumero)
                ) {

                    return response.status(400).json({
                        error:
                            'Latitude e longitude inválidas.'
                    });

                }

                if (
                    latitudeNumero < -90 ||
                    latitudeNumero > 90
                ) {

                    return response.status(400).json({
                        error:
                            'Latitude deve estar entre -90 e 90.'
                    });

                }

                if (
                    longitudeNumero < -180 ||
                    longitudeNumero > 180
                ) {

                    return response.status(400).json({
                        error:
                            'Longitude deve estar entre -180 e 180.'
                    });

                }

                dadosAtualizacao.latitude =
                    latitudeNumero;

                dadosAtualizacao.longitude =
                    longitudeNumero;
            }

            // ==========================================
            // ATUALIZA ONLINE
            // ==========================================

            if (online !== undefined) {

                dadosAtualizacao.online =
                    online ? 1 : 0;

            }

            // ==========================================
            // NADA PARA ATUALIZAR
            // ==========================================

            if (
                Object.keys(dadosAtualizacao).length === 0
            ) {

                return response.status(400).json({
                    error:
                        'Nenhum dado foi informado para atualização.'
                });

            }

            // ==========================================
            // ATUALIZA MOTORISTA
            // ==========================================

            await connection('motoristas')
                .where(
                    'id',
                    motorista.id
                )
                .update(dadosAtualizacao);

            // ==========================================
            // BUSCA MOTORISTA ATUALIZADO
            // ==========================================

            const motoristaAtualizado =
                await connection('motoristas')
                    .where(
                        'id',
                        motorista.id
                    )
                    .select(
                        'id',
                        'usuario_id',
                        'cnh',
                        'status',
                        'online',
                        'latitude',
                        'longitude',
                        'created_at',
                        'updated_at'
                    )
                    .first();

            // ==========================================
            // RESPOSTA
            // ==========================================

            return response.json({

                message:
                    'Dados do motorista atualizados com sucesso.',

                motorista:
                    motoristaAtualizado

            });

        } catch (error) {

            console.error(
                'Erro ao atualizar dados do motorista:',
                error
            );

            return response.status(500).json({
                error:
                    'Erro ao atualizar dados do motorista.'
            });

        }

    }

};