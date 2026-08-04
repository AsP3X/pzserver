<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    /**
     * Run the migrations.
     *
     * One row per sample, kept deliberately narrow: this table grows by a row
     * every few minutes forever, so anything stored here is paid for daily.
     */
    public function up(): void
    {
        Schema::create('server_status_samples', function (Blueprint $table) {
            $table->id();
            $table->boolean('online');
            $table->unsignedSmallInteger('player_count')->default(0);
            $table->string('game_status');
            $table->timestamp('sampled_at')->index();
        });
    }

    /**
     * Reverse the migrations.
     */
    public function down(): void
    {
        Schema::dropIfExists('server_status_samples');
    }
};
