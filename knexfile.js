// Update with your config settings.
module.exports = {

  development: {
    client: '',
    connection: {
      host : "travelinn.mysql.dbaas.com.br",
      database: "travelinn",
      user: "travelinn",
      password: "Ent@0669"
    },
    migrations: {
      directory: ''
    },
    useNullAsDefault: true,
  },

  staging: {
    client: '',
    connection: {
      database: '',
      user:     '',
      password: ''
    },
    pool: {
      min: 2,
      max: 10
    },
    migrations: {
      tableName: ''
    }
  },

  production: {
    client: 'mysql',
    connection: {
      host : "travelinn.mysql.dbaas.com.br",
      database: "travelinn",
      user: "travelinn",
      password: "Ent@0669"
    },
    
    pool: {
      min: 2,
      max: 10
    },
    migrations: {
      directory: './src/database/migrations'
    },
    useNullAsDefault: true,
  },

};