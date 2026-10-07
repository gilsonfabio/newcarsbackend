exports.up = function(knex) {
    return knex.schema.createTable('usrMovies', function(table) {
        table.increments('usrId').primary();
        table.string('usrNome').notNullable();
        table.string('usrEmail').notNullable(); 
        table.string('usrSenha').notNullable();
        table.integer('usrNivAcesso').notNullable();     
        table.string('usrStatus').notNullable();      
    });
};
  
exports.down = function(knex) {
    return knex.schema.dropTable('usrMovies');
};