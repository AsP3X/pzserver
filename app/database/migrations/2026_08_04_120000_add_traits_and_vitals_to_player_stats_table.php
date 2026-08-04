<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    /**
     * Run the migrations.
     *
     * Both stay nullable: a server still running an older KnoxRelay exports
     * neither, and the character sheet has to render that gracefully rather
     * than pretend the player has no traits and perfect health.
     */
    public function up(): void
    {
        Schema::table('player_stats', function (Blueprint $table) {
            $table->json('traits')->nullable()->after('skills');
            $table->json('vitals')->nullable()->after('traits');
        });
    }

    /**
     * Reverse the migrations.
     */
    public function down(): void
    {
        Schema::table('player_stats', function (Blueprint $table) {
            $table->dropColumn(['traits', 'vitals']);
        });
    }
};
